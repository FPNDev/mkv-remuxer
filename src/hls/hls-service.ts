import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { CacheLayout } from '../cache/cache-layout.js';
import {
  DiskGuard,
  type CacheUsage,
  type HostStore,
} from '../cache/disk-guard.js';
import { InterleavingNotes } from '../cache/interleaving-notes.js';
import { MetadataCache } from '../cache/metadata-cache.js';
import { SegmentCache } from '../cache/segment-cache.js';
import { AbandonedError, MediaTimeoutError, NotFoundError } from '../errors.js';
import type {
  SourceFile,
  SourceListing,
  SourceProvider,
} from '../io/byte-source.js';
import { errorMessage, silentLogger, type Logger } from '../logger.js';
import { withTimeout } from '../util/async.js';
import { exists } from '../util/fs.js';
import { SingleFlight } from '../util/single-flight.js';
import { Priority, TaskQueue } from '../util/task-queue.js';
import type { Asset } from './asset.js';
import { AssetRegistry, MATROSKA_FILE } from './asset-registry.js';
import { FfmpegError, FfmpegSupervisor } from './ffmpeg.js';
import { renditionPath, segmentFileName } from './playlists.js';
import { Remuxer } from './remux.js';
import { WarmQueue } from './warm-queue.js';

export interface HlsServiceOptions {
  cacheDir: string;
  provider: SourceProvider;
  ffmpegPath?: string;
  segmentDuration?: number;
  keepWarmS?: number;
  warmSegments?: number;
  warmConcurrency?: number;
  requestTimeoutMs?: number;
  maxConcurrentJobs?: number;
  jobTimeoutMs?: number;
  audioReadFromKeyframe?: boolean;
  segmentCacheBytes?: number;
  metadataCacheBytes?: number;
  cacheTotalBytes?: number;
  cacheSweepMs?: number;
  hostStores?: Record<string, HostStore>;
  hostDataDir?: string;
  markerFile?: (sourceId: string) => string;
  logger?: Logger;
}

export interface ServedFile {
  path: string;
  contentType: string;
  cacheControl: string;
  dropped?: AbortSignal | undefined;
}

export interface WarmStatus {
  ready: boolean;
  queued: boolean;
  warming: boolean;
  pending: number;
  full: boolean;
}

export interface PlayableFile extends SourceFile {
  playable: boolean;
}

export interface FileListing {
  files: PlayableFile[];
}

export interface JobStats {
  running: number;
  runningBackground: number;
  queued: number;
}

export interface HlsStatus {
  jobs: JobStats;
  segmentCacheBytes: number;
  cache: CacheUsage;
}

type HlsServiceDeps = {
  layout: CacheLayout;
  provider: SourceProvider;
  segments: SegmentCache;
  metadata: MetadataCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  guard: DiskGuard;
  segmentDuration: number;
  keepWarm: boolean;
  warmSegments: number;
  warmConcurrency: number;
  requestTimeoutMs: number;
  logger: Logger;
};

const MIB = 1024 * 1024;

const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

const SEGMENT_NAME = /^(\d+)\.(m4s|vtt)$/u;

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
// Files under a source id cannot change, so they cache indefinitely.
const PLAYLIST_CACHE = 'public, max-age=86400, immutable';
const MEDIA_CACHE = 'public, max-age=86400, immutable';

/**
 * Entry points behind the HLS routes: master playlist, warm, file list,
 * and resolving one media path to a file on disk.
 */
export class HlsService {
  private readonly registry: AssetRegistry;
  private readonly warming: WarmQueue;
  private readonly flights = new SingleFlight();

  private constructor(private readonly deps: HlsServiceDeps) {
    this.registry = new AssetRegistry({
      layout: deps.layout,
      provider: deps.provider,
      segments: deps.segments,
      remuxer: deps.remuxer,
      queue: deps.queue,
      segmentDuration: deps.segmentDuration,
      warmSegments: deps.warmSegments,
      logger: deps.logger,
    });
    this.warming = new WarmQueue({
      concurrency: deps.warmConcurrency,
      warm: (sourceId, fileIndex) => this.warmUp(sourceId, fileIndex),
      logger: deps.logger,
    });
  }

  static async create(options: HlsServiceOptions): Promise<HlsService> {
    const {
      cacheDir,
      provider,
      ffmpegPath = 'ffmpeg',
      segmentDuration = 2,
      keepWarmS = 5,
      warmSegments = 2,
      warmConcurrency = 4,
      requestTimeoutMs = 120_000,
      maxConcurrentJobs = 64,
      jobTimeoutMs = 180_000,
      audioReadFromKeyframe = true,
      segmentCacheBytes = 15_360 * MIB,
      metadataCacheBytes = 2048 * MIB,
      cacheTotalBytes = segmentCacheBytes + metadataCacheBytes,
      cacheSweepMs = 300_000,
      hostStores = {},
      hostDataDir,
      markerFile,
      logger = silentLogger,
    } = options;

    try {
      await new FfmpegSupervisor(ffmpegPath).run({ args: ['-version'] });
    } catch (err) {
      throw err instanceof FfmpegError
        ? err
        : new FfmpegError(errorMessage(err), '');
    }

    const layout = new CacheLayout(cacheDir);
    await mkdir(layout.hlsDir, { recursive: true });

    const segments = new SegmentCache(layout.hlsDir, segmentCacheBytes, logger);
    await segments.load();
    const remuxer = new Remuxer({
      ffmpegPath,
      timeoutMs: jobTimeoutMs,
      audioReadFromKeyframe,
      notes: new InterleavingNotes(layout, logger),
      logger,
    });
    await remuxer.restoreNotes();
    const metadata = new MetadataCache(layout, metadataCacheBytes, {
      logger,
      hostDataDir,
      markerFile,
    });
    const queue = new TaskQueue(
      maxConcurrentJobs,
      keepWarmS ? Math.max(segmentDuration + 1, keepWarmS) : 0,
      logger,
    );
    const guard = new DiskGuard({
      layout,
      stores: hostStores,
      hostDataDir,
      segments,
      metadata,
      totalBytes: cacheTotalBytes,
      intervalMs: cacheSweepMs,
      inUse: () => provider.active?.() ?? new Set(),
      logger,
    });

    const service = new HlsService({
      layout,
      provider,
      segments,
      metadata,
      remuxer,
      queue,
      guard,
      segmentDuration,
      keepWarm: !!keepWarmS,
      warmSegments,
      warmConcurrency,
      requestTimeoutMs,
      logger,
    });
    guard.start();

    return service;
  }

  async master(
    sourceId: string,
    fileParam?: number,
    signal?: AbortSignal,
  ): Promise<ServedFile> {
    checkSourceId(sourceId);
    const { layout, metadata } = this.deps;
    metadata.touch(sourceId);

    const fileIndex =
      fileParam ?? (await this.registry.defaultFileIndex(sourceId));
    const file = layout.masterFile(sourceId, fileIndex);

    if (!(await exists(file))) {
      await this.orTimeout(
        this.publish(sourceId, fileIndex, Priority.Foreground, signal),
        `the playlists for ${sourceId}/${fileIndex}`,
      );
    }
    this.startEagerly(sourceId, fileIndex);

    return { path: file, contentType: PLAYLIST_TYPE, cacheControl: 'no-cache' };
  }

  async warm(sourceId: string, fileIndex?: number): Promise<WarmStatus> {
    checkSourceId(sourceId);
    this.deps.metadata.touch(sourceId);

    const ready = await this.alreadyWarm(sourceId, fileIndex);
    const queued = ready ? false : this.warming.request(sourceId, fileIndex);
    const warming = queued || this.warming.knows(sourceId, fileIndex);
    return {
      ready,
      queued,
      warming,
      pending: this.warming.pending,
      full: !ready && !warming && this.warming.full,
    };
  }

  async files(sourceId: string, signal?: AbortSignal): Promise<FileListing> {
    checkSourceId(sourceId);
    const { metadata, provider } = this.deps;
    metadata.touch(sourceId);

    const key = `info:${sourceId}`;
    const info: SourceListing = await this.orTimeout(
      this.flights.run(key, signal, () => provider.list(sourceId)),
      `the file list of ${sourceId}`,
    );

    return {
      ...info,
      files: info.files.map((file) => ({
        index: file.index,
        name: file.name,
        path: file.path,
        length: file.length,
        playable: MATROSKA_FILE.test(file.name),
      })),
    };
  }

  async resolve(
    sourceId: string,
    fileIndex: number,
    parts: string[],
    signal?: AbortSignal,
  ): Promise<ServedFile> {
    checkSourceId(sourceId);
    this.deps.provider.touch?.(sourceId);
    this.deps.metadata.touch(sourceId);

    // Every part of the path comes from the client. The shape is checked here
    // and the names are checked against the asset before any file is opened.
    const [kind, ...rest] = parts;
    const [trackParam, name] =
      kind === 'video' && rest.length === 1
        ? [undefined, rest[0]]
        : (kind === 'audio' || kind === 'subtitles') && rest.length === 2
          ? rest
          : [];
    if (!kind || !name) {
      throw new NotFoundError(`Unsupported path "${parts.join('/')}"`);
    }
    const asset = await this.registry.get(sourceId, fileIndex);
    if (trackParam !== undefined && !/^\d+$/u.test(trackParam)) {
      throw new NotFoundError(`Invalid track "${trackParam}"`);
    }
    const rendition = asset.rendition(
      kind,
      trackParam === undefined ? undefined : Number(trackParam),
    );
    const file = path.join(asset.dirOf(rendition), name);
    const mediaType = rendition.type === 'audio' ? 'audio/mp4' : 'video/mp4';

    if (name === 'index.m3u8') {
      if (!(await exists(file))) {
        await this.orTimeout(
          asset.writePlaylists(),
          `the playlists for ${sourceId}/${fileIndex}`,
        );
      }
      return {
        path: file,
        contentType: PLAYLIST_TYPE,
        cacheControl: PLAYLIST_CACHE,
      };
    }

    if (name === 'init.mp4' && rendition.type !== 'subtitle') {
      await this.orTimeout(
        asset.ensureInit(rendition, file, Priority.Foreground, signal),
        `the init section of ${renditionPath(rendition)}`,
      );
      return {
        path: file,
        contentType: mediaType,
        cacheControl: MEDIA_CACHE,
      };
    }

    const segment = SEGMENT_NAME.exec(name);
    const n = Number(segment?.[1]);
    // Comparing against the name this rendition would generate rejects a vtt
    // asked of video, a padded number, and anything with extra characters.
    if (!segment || name !== segmentFileName(rendition, n)) {
      throw new NotFoundError(
        `Unexpected segment name "${name}" for ${renditionPath(rendition)}`,
      );
    }
    if (n >= asset.segmentCount) {
      throw new NotFoundError(
        `Segment ${n} is past the end of ${asset.index.fileName} (${asset.segmentCount} segments)`,
      );
    }

    if (!signal?.aborted) {
      const mainSegment = this.orTimeout(
        asset.ensureSegment(rendition, n, Priority.Foreground, signal),
        `segment ${n} of ${renditionPath(rendition)}`,
      );

      // Keep the source warm by quietly prefetching the next segment
      // Dropped after keepWarmS unless is promoted (requested)
      if (this.deps.keepWarm && n < asset.segmentCount - 1) {
        for (
          let i = n + 1;
          i < Math.min(n + 1 + this.deps.warmSegments, asset.segmentCount);
          i++
        ) {
          asset
            .ensureSegment(rendition, i, Priority.Background, signal, true)
            .catch((err) => {
              if (!(err instanceof AbandonedError)) {
                this.deps.logger.warn('Keep-warm render failed', {
                  rendition: renditionPath(rendition),
                  n: i,
                  error: errorMessage(err),
                });
              }
            });
        }
      }

      await mainSegment;
    }

    return {
      path: file,
      contentType:
        rendition.type === 'subtitle' ? 'text/vtt; charset=utf-8' : mediaType,
      cacheControl: MEDIA_CACHE,
    };
  }

  status(): HlsStatus {
    return {
      jobs: this.deps.queue.stats,
      segmentCacheBytes: this.deps.segments.usedBytes,
      cache: this.deps.guard.lastUsage,
    };
  }

  close(): void {
    this.deps.guard.stop();
    this.deps.remuxer.killAll();
  }

  private async publish(
    sourceId: string,
    fileIndex: number,
    priority: Priority = Priority.Foreground,
    signal?: AbortSignal,
  ): Promise<Asset> {
    const asset = await this.registry.get(
      sourceId,
      fileIndex,
      priority,
      signal,
    );
    await asset.writePlaylists();

    return asset;
  }

  private startEagerly(sourceId: string, fileIndex: number): void {
    this.registry
      .get(sourceId, fileIndex)
      .then((asset) => {
        asset.eagerStart();
      })
      .catch(() => {});
  }

  private async alreadyWarm(
    sourceId: string,
    fileIndex: number | undefined,
  ): Promise<boolean> {
    const index = fileIndex ?? (await this.registry.defaultFileIndex(sourceId));
    return exists(this.deps.layout.masterFile(sourceId, index));
  }

  // Renders the opening of the default tracks so a later play starts without
  // waiting for indexing and remux.
  private async warmUp(
    sourceId: string,
    fileParam: number | undefined,
  ): Promise<void> {
    const started = Date.now();
    this.deps.provider.warm?.(sourceId);
    const fileIndex =
      fileParam ?? (await this.registry.defaultFileIndex(sourceId));
    const asset = await this.publish(sourceId, fileIndex, Priority.Background);

    const tracks = asset.openingTracks();
    for (const rendition of tracks) {
      await asset.ensureInit(
        rendition,
        path.join(asset.dirOf(rendition), 'init.mp4'),
        Priority.Background,
        undefined,
      );
    }
    const last = Math.min(this.deps.warmSegments, asset.segmentCount);
    for (let n = 0; n < last; n++) {
      for (const rendition of tracks) {
        await asset
          .ensureSegment(rendition, n, Priority.Background, undefined)
          .catch(() => {});
      }
    }
    this.deps.logger.info('Warmed a title', {
      sourceId,
      fileIndex,
      name: asset.index.fileName,
      segments: last,
      ms: Date.now() - started,
    });
  }

  // Bounds how long a client is held. The work behind it keeps running for
  // whoever asks next.
  private orTimeout<T>(work: Promise<T>, what: string): Promise<T> {
    return withTimeout(work, this.deps.requestTimeoutMs, () => {
      const seconds = Math.round(this.deps.requestTimeoutMs / 1000);
      this.deps.logger.warn('Gave up waiting', {
        what,
        seconds,
        jobs: this.deps.queue.stats,
      });
      return new MediaTimeoutError(
        `Timed out after ${seconds}s producing ${what}`,
      );
    });
  }
}

function checkSourceId(sourceId: string): void {
  if (!SOURCE_ID.test(sourceId)) {
    throw new NotFoundError(`Invalid source id "${sourceId}"`);
  }
}
