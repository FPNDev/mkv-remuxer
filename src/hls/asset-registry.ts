import { mkdir, rm } from 'node:fs/promises';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { NotFoundError, UnsupportedMediaError } from '../errors.js';
import type { LeasedSource, SourceProvider } from '../io/byte-source.js';
import { errorMessage, type Logger } from '../logger.js';
import {
  buildMediaIndex,
  MEDIA_INDEX_VERSION,
  segmentCount,
  type MediaIndex,
} from '../media/media-index.js';
import { readJson, writeFileAtomic } from '../util/fs.js';
import { SizeLru } from '../util/lru.js';
import { SingleFlight } from '../util/single-flight.js';
import { Priority, type TaskQueue } from '../util/task-queue.js';
import { Asset } from './asset.js';
import type { Remuxer } from './remux.js';

export const MATROSKA_FILE = /\.(mkv|mk3d|webm)$/iu;
// An asset rebuilds from its on-disk index cheaply, so the live set is
// capped by count rather than by size.
const MEMORY_ASSETS = 64;

type IndexBuild = {
  index: MediaIndex;
  source?: LeasedSource | undefined;
};

export type AssetRegistryOptions = {
  layout: CacheLayout;
  provider: SourceProvider;
  segments: SegmentCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  segmentDuration: number;
  warmSegments: number;
  masterUriPrefix: (sourceId: string, fileId: string) => string;
  logger: Logger;
};

export class AssetRegistry {
  private readonly assets = new Map<string, Asset>();
  private readonly order: SizeLru<string>;
  private readonly flights = new SingleFlight();

  constructor(private readonly options: AssetRegistryOptions) {
    this.order = new SizeLru(MEMORY_ASSETS);
  }

  static indexKey(sourceId: string, fileId: string): string {
    return `index:${sourceId}/${fileId}`;
  }

  static segmentKey(
    sourceId: string,
    fileId: string,
    parts: string[],
  ): string {
    return `segment:${sourceId}/${fileId}/${parts.join('/')}`;
  }

  async get(
    sourceId: string,
    fileId: string,
    priority: Priority = Priority.Foreground,
    signal?: AbortSignal,
  ): Promise<Asset> {
    const key = `${sourceId}/${fileId}`;
    const cached = this.assets.get(key);
    if (cached) {
      this.order.touch(key);

      return cached;
    }
    const indexKey = AssetRegistry.indexKey(sourceId, fileId);
    if (priority === Priority.Foreground) {
      this.options.queue.promote(indexKey);
    }

    const existing = this.assets.get(key);
    if (existing) {
      return existing;
    }
    const { index, source } = await this.indexOf(
      sourceId,
      fileId,
      priority,
      signal,
    );

    const asset = this.build(sourceId, fileId, index);
    this.remember(key, asset);

    source?.onCorrupt?.((error) => {
      asset.drop(error);
      void this.forget(sourceId, fileId);
    });

    return asset;
  }

  // The largest Matroska file is the feature; samples and extras are smaller.
  async defaultFileId(sourceId: string): Promise<string> {
    const info = await this.options.provider.list(sourceId);
    const firstFile = info.files.find((file) => MATROSKA_FILE.test(file.name));
    if (!firstFile) {
      throw new NotFoundError('Source contains no MKV or WebM files');
    }
    return firstFile.id;
  }

  private build(sourceId: string, fileId: string, index: MediaIndex): Asset {
    const {
      layout,
      provider,
      segments,
      remuxer,
      queue,
      warmSegments,
      masterUriPrefix,
      logger,
    } = this.options;

    return new Asset({
      sourceId,
      fileId,
      index,
      layout,
      provider,
      segments,
      remuxer,
      queue,
      warmSegments,
      masterUriPrefix,
      logger,
    });
  }

  private remember(key: string, asset: Asset): void {
    this.assets.set(key, asset);
    this.order.set(key, 1);
    for (const evicted of this.order.trim()) {
      this.assets.delete(evicted);
    }
  }

  private async forget(sourceId: string, fileId: string): Promise<void> {
    const mediaDir = this.options.layout.mediaDir(sourceId, fileId);
    try {
      await rm(mediaDir, { recursive: true, force: true });
    } catch (err) {
      this.options.logger.warn(
        'Could not delete media built from corrupt data',
        {
          sourceId,
          fileId,
          error: errorMessage(err),
        },
      );
    }
    this.options.segments.forgetUnder(mediaDir);
    const key = `${sourceId}/${fileId}`;
    this.assets.delete(key);
    this.order.delete(key);
  }

  private async indexOf(
    sourceId: string,
    fileId: string,
    priority: Priority,
    signal?: AbortSignal,
  ): Promise<IndexBuild> {
    const { layout, segmentDuration, segments } = this.options;
    const indexFile = layout.indexFile(sourceId, fileId);

    const saved = await readJson<MediaIndex>(indexFile);
    if (
      // A saved index is only usable under the same format version and segment
      // duration. Segments rendered against a stale one go with it.
      saved?.version === MEDIA_INDEX_VERSION &&
      saved.targetDuration === segmentDuration
    ) {
      return { index: saved };
    }

    const assetKey = AssetRegistry.indexKey(sourceId, fileId);
    const mediaDir = layout.mediaDir(sourceId, fileId);
    await this.flights.run(`remove:${assetKey}`, undefined, async () => {
      await rm(mediaDir, { recursive: true, force: true });
    });
    segments.forgetUnder(mediaDir);

    const { index, source } = await this.readIndex(
      sourceId,
      fileId,
      priority,
      signal,
    );

    await this.flights.run(`save:${assetKey}`, undefined, async () => {
      await mkdir(mediaDir, { recursive: true });
      await writeFileAtomic(indexFile, JSON.stringify(index));
    });

    return { index, source };
  }

  private readIndex(
    sourceId: string,
    fileId: string,
    priority: Priority,
    signal?: AbortSignal,
  ): Promise<IndexBuild> {
    const { queue, provider, segmentDuration, logger } = this.options;

    const key = AssetRegistry.indexKey(sourceId, fileId);

    return this.flights.run(
      key,
      signal,
      () =>
        queue.run({ key, priority }, ({ signal }) =>
          provider.lease(
            sourceId,
            fileId,
            { purpose: 'index', signal },
            async (source) => {
              if (!MATROSKA_FILE.test(source.name)) {
                throw new UnsupportedMediaError(
                  `${source.name} is not an MKV or WebM file`,
                );
              }

              const started = Date.now();

              let index: MediaIndex;

              try {
                index = await buildMediaIndex(
                  source,
                  source.name,
                  segmentDuration,
                );
              } catch (err) {
                source.release?.();
                throw err;
              }

              logger.info('Indexed media file', {
                sourceId,
                file: source.name,
                duration: Math.round(index.duration),
                segments: segmentCount(index),
                tracks: index.tracks.length,
                ms: Date.now() - started,
              });

              return { index, source };
            },
          ),
        ),
      () => {
        queue.abandon(key);
      },
    );
  }
}
