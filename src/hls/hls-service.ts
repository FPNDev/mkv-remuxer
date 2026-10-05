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
  /**
   * Directories the host keeps under its own budget but wants counted toward
   * `cacheTotalBytes`, keyed by a name used in `CacheUsage.stores`.
   */
  hostStores?: Record<string, HostStore>;
  /**
   * A host directory with one subdirectory per source id. Each subdirectory
   * counts as that source's metadata and is deleted when the source is evicted.
   */
  hostDataDir?: string;
  /**
   * Prepended to the rendition URIs in a master playlist. The default, `''`,
   * resolves them against the master's own URL, which suits a master served
   * through `resolve(sourceId, fileId, ['master.m3u8'])`. Set it when the
   * master is served from somewhere else.
   */
  masterUriPrefix?: (sourceId: string, fileId: string) => string;
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

/**
 * HLS over the Matroska files of the sources a `SourceProvider` serves. Every
 * media URL has the shape `<sourceId>/<fileId>/<parts...>`; route it to
 * `resolve`.
 */
export interface HlsService {
  /**
   * The master playlist of `fileId`, or of the source's first Matroska file
   * when it is omitted. Builds the index and playlists on first use.
   */
  master(
    sourceId: string,
    fileId?: string,
    signal?: AbortSignal,
  ): Promise<ServedFile>;
  /** Starts rendering the opening of a file in the background. */
  warm(sourceId: string, fileId?: string): Promise<WarmStatus>;
  files(sourceId: string, signal?: AbortSignal): Promise<FileListing>;
  /** Maps one media URL path to a file on disk, rendering it if needed. */
  resolve(
    sourceId: string,
    fileId: string,
    parts: string[],
    signal?: AbortSignal,
  ): Promise<ServedFile>;
  status(): HlsStatus;
  /** Stops the cache sweep and kills running ffmpeg processes. */
  close(): void;
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
  masterUriPrefix: (sourceId: string, fileId: string) => string;
  logger: Logger;
};

const MIB = 1024 * 1024;

const ID = /^[A-Za-z0-9_-]{1,128}$/u;

const SEGMENT_NAME = /^(\d+)\.(m4s|vtt)$/u;

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
// Files under a source id cannot change, so they cache indefinitely.
const PLAYLIST_CACHE = 'public, max-age=86400, immutable';
const MEDIA_CACHE = 'public, max-age=86400, immutable';

/** Creates the service: checks ffmpeg, loads the caches and starts sweeping. */
export async function createHlsService(
  options: HlsServiceOptions,
): Promise<HlsService> {
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
    masterUriPrefix = () => '',
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

  const service = new Service({
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
    masterUriPrefix,
    logger,
  });
  guard.start();

  return service;
}

class Service implements HlsService {
  private readonly registry: AssetRegistry;
  private readonly warming: WarmQueue;
  private readonly flights = new SingleFlight();

  constructor(private readonly deps: HlsServiceDeps) {
    this.registry = new AssetRegistry({
      layout: deps.layout,
      provider: deps.provider,
      segments: deps.segments,
      remuxer: deps.remuxer,
      queue: deps.queue,
      segmentDuration: deps.segmentDuration,
      warmSegments: deps.warmSegments,
      masterUriPrefix: deps.masterUriPrefix,
      logger: deps.logger,
    });
    this.warming = new WarmQueue({
      concurrency: deps.warmConcurrency,
      warm: (sourceId, fileId) => this.warmUp(sourceId, fileId),
      logger: deps.logger,
    });
  }

  async master(
    sourceId: string,
    fileParam?: string,
    signal?: AbortSignal,
  ): Promise<ServedFile> {
    checkId(sourceId, 'source');
    this.deps.metadata.touch(sourceId);

    const fileId = await this.fileOrDefault(sourceId, fileParam);
    return this.servedMaster(sourceId, fileId, signal);
  }

  async warm(sourceId: string, fileId?: string): Promise<WarmStatus> {
    checkId(sourceId, 'source');
    if (fileId !== undefined) {
      checkId(fileId, 'file');
    }
    this.deps.metadata.touch(sourceId);

    const ready = await this.alreadyWarm(sourceId, fileId);
    const queued = ready ? false : this.warming.request(sourceId, fileId);
    const warming = queued || this.warming.knows(sourceId, fileId);
    return {
      ready,
      queued,
      warming,
      pending: this.warming.pending,
      full: !ready && !warming && this.warming.full,
    };
  }

  async files(sourceId: string, signal?: AbortSignal): Promise<FileListing> {
    checkId(sourceId, 'source');
    const { metadata, provider } = this.deps;
    metadata.touch(sourceId);

    const key = `info:${sourceId}`;
    const info: SourceListing = await this.orTimeout(
      this.flights.run(key, signal, () => provider.list(sourceId)),
      `the file list of ${sourceId}`,
    );

    return {
      ...info,
      // Copies rather than mutates: a provider may hand out a cached listing.
      // oxlint-disable-next-line oxc/no-map-spread
      files: info.files.map((file) => ({
        ...file,
        playable: MATROSKA_FILE.test(file.name),
      })),
    };
  }

  async resolve(
    sourceId: string,
    fileId: string,
    parts: string[],
    signal?: AbortSignal,
  ): Promise<ServedFile> {
    checkId(sourceId, 'source');
    checkId(fileId, 'file');
    this.deps.provider.touch?.(sourceId);
    this.deps.metadata.touch(sourceId);

    if (parts.length === 1 && parts[0] === 'master.m3u8') {
      return this.servedMaster(sourceId, fileId, signal);
    }

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
    const asset = await this.registry.get(sourceId, fileId);
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
          `the playlists for ${sourceId}/${fileId}`,
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

  private async servedMaster(
    sourceId: string,
    fileId: string,
    signal: AbortSignal | undefined,
  ): Promise<ServedFile> {
    const file = this.deps.layout.masterFile(sourceId, fileId);

    if (!(await exists(file))) {
      await this.orTimeout(
        this.publish(sourceId, fileId, Priority.Foreground, signal),
        `the playlists for ${sourceId}/${fileId}`,
      );
    }
    this.startEagerly(sourceId, fileId);

    return { path: file, contentType: PLAYLIST_TYPE, cacheControl: 'no-cache' };
  }

  private async fileOrDefault(
    sourceId: string,
    fileId: string | undefined,
  ): Promise<string> {
    const id = fileId ?? (await this.registry.defaultFileId(sourceId));
    checkId(id, 'file');
    return id;
  }

  private async publish(
    sourceId: string,
    fileId: string,
    priority: Priority = Priority.Foreground,
    signal?: AbortSignal,
  ): Promise<Asset> {
    const asset = await this.registry.get(sourceId, fileId, priority, signal);
    await asset.writePlaylists();

    return asset;
  }

  private startEagerly(sourceId: string, fileId: string): void {
    this.registry
      .get(sourceId, fileId)
      .then((asset) => {
        asset.eagerStart();
      })
      .catch(() => {});
  }

  private async alreadyWarm(
    sourceId: string,
    fileId: string | undefined,
  ): Promise<boolean> {
    const id = await this.fileOrDefault(sourceId, fileId);
    return exists(this.deps.layout.masterFile(sourceId, id));
  }

  // Renders the opening of the default tracks so a later play starts without
  // waiting for indexing and remux.
  private async warmUp(
    sourceId: string,
    fileParam: string | undefined,
  ): Promise<void> {
    const started = Date.now();
    this.deps.provider.warm?.(sourceId);
    const fileId = await this.fileOrDefault(sourceId, fileParam);
    const asset = await this.publish(sourceId, fileId, Priority.Background);

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
      fileId,
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

function checkId(id: string, what: 'source' | 'file'): void {
  if (!ID.test(id)) {
    throw new NotFoundError(`Invalid ${what} id "${id}"`);
  }
}
