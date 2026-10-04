import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, type Logger } from '../logger.js';
import { TEMP_SUFFIX } from '../util/fs.js';
import { isSegmentFile, type CacheLayout } from './cache-layout.js';
import type { MetadataCache } from './metadata-cache.js';
import type { SegmentCache } from './segment-cache.js';

// A temp file younger than this may belong to a write still in flight.
const STALE_TEMP_MS = 60 * 60_000;
// Evict in steps so the oldest store is re-picked as the order shifts.
const EVICT_CHUNK = 64 * 1024 * 1024;
// Bounded parallelism: a full cache is tens of thousands of files and one
// event loop also serves playback.
const STAT_BATCH = 64;

type Candidate = {
  usedAt: number | undefined;
  take: (bytes: number) => Promise<number>;
  add: (took: number) => void;
};

/**
 * A directory the host keeps under its own budget but wants counted toward the
 * shared total. Its files are measured and evicted alongside the remuxer's.
 */
export interface HostStore {
  dir: string;
  oldestUsedAt(): number | undefined;
  /** Frees about `bytes`, oldest first. Resolves to the bytes actually freed. */
  evictOldest(bytes: number): Promise<number>;
}

export type DiskGuardOptions = {
  layout: CacheLayout;
  stores: Record<string, HostStore>;
  hostDataDir?: string | undefined;
  segments: SegmentCache;
  metadata: MetadataCache;
  totalBytes: number;
  intervalMs: number;
  inUse: () => Set<string>;
  logger: Logger;
};

type FreedBytes = {
  stores: Record<string, number>;
  segments: number;
  metadata: number;
};

/** What the last cache sweep measured, in bytes. */
export interface CacheUsage {
  stores: Record<string, number>;
  segments: number;
  metadata: number;
  total: number;
  limit: number;
  titles: number;
  freed: FreedBytes;
  sweptAt: number;
}

type Title = {
  metadataBytes: number;
  writtenAt: number;
};

/**
 * Sweeps the cache directory on a timer: measures what is on disk, feeds the
 * result back to the budgets, then evicts oldest first until the total fits.
 * Disk is the record, so a file deleted outside the process is noticed.
 */
export class DiskGuard {
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;
  private usage: CacheUsage;

  constructor(private readonly options: DiskGuardOptions) {
    this.usage = {
      stores: this.zeroPerStore(),
      segments: 0,
      metadata: 0,
      total: 0,
      limit: options.totalBytes,
      titles: 0,
      freed: { stores: this.zeroPerStore(), segments: 0, metadata: 0 },
      sweptAt: 0,
    };
  }

  get lastUsage(): CacheUsage {
    return this.usage;
  }

  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async sweep(): Promise<CacheUsage> {
    // Sweeps never overlap: a slow one would evict against stale sizes.
    if (this.sweeping) {
      return this.usage;
    }
    this.sweeping = true;
    try {
      const { layout, stores, hostDataDir, metadata, totalBytes, logger } =
        this.options;
      const titles = new Map<string, Title>();
      const storeBytes: Record<string, number> = {};
      let measured = 0;
      for (const [name, store] of Object.entries(stores)) {
        const { total } = await this.measure(store.dir, titles, false);
        storeBytes[name] = total;
        measured += total;
      }
      if (hostDataDir) {
        measured += (await this.measure(hostDataDir, titles, true)).total;
      }
      const hls = await this.measure(layout.hlsDir, titles, true);
      measured += hls.total;
      for (const [sourceId, title] of [...titles].sort(
        ([, a], [, b]) => a.writtenAt - b.writtenAt,
      )) {
        metadata.note(sourceId, title.metadataBytes, title.writtenAt);
      }
      metadata.keepOnly(new Set(titles.keys()));

      const busy = this.options.inUse();
      // A source in use keeps its metadata, however old it is.
      const pinned = (sourceId: string) => busy.has(sourceId);
      let freed: FreedBytes = {
        stores: this.zeroPerStore(),
        segments: 0,
        metadata: 0,
      };
      freed.metadata += await metadata.trimToBudget(pinned);

      const over = measured - freed.metadata - totalBytes;
      if (over > 0) {
        freed = await this.evict(over, pinned, freed);
      }

      let storesFreed = 0;
      const storesLeft: Record<string, number> = {};
      for (const [name, bytes] of Object.entries(storeBytes)) {
        storesLeft[name] = bytes - freed.stores[name];
        storesFreed += freed.stores[name];
      }
      this.usage = {
        stores: storesLeft,
        segments: hls.segments - freed.segments,
        metadata: metadata.usedBytes,
        total: measured - storesFreed - freed.segments - freed.metadata,
        limit: totalBytes,
        titles: titles.size,
        freed,
        sweptAt: Date.now(),
      };
      logger.debug('Cache swept', { ...this.usage });
      return this.usage;
    } catch (err: unknown) {
      this.options.logger.warn('Could not sweep the cache', {
        error: errorMessage(err),
      });
      return this.usage;
    } finally {
      this.sweeping = false;
    }
  }

  // Takes from whichever store holds the globally oldest entry, so one busy
  // store cannot push another out.
  private async evict(
    over: number,
    pinned: (sourceId: string) => boolean,
    freed: FreedBytes,
  ): Promise<FreedBytes> {
    const { stores, segments, metadata, logger } = this.options;
    const result: FreedBytes = { ...freed, stores: { ...freed.stores } };
    let remaining = over;

    while (remaining > 0) {
      const candidates: Candidate[] = [];
      for (const [name, store] of Object.entries(stores)) {
        candidates.push({
          usedAt: store.oldestUsedAt(),
          take: (bytes) => store.evictOldest(bytes),
          add: (took) => {
            result.stores[name] += took;
          },
        });
      }
      candidates.push(
        {
          usedAt: segments.oldestUsedAt(),
          take: (bytes) => segments.evictOldest(bytes),
          add: (took) => {
            result.segments += took;
          },
        },
        {
          usedAt: metadata.oldestUsedAt(pinned),
          take: (bytes) => metadata.evictOldest(bytes, pinned),
          add: (took) => {
            result.metadata += took;
          },
        },
      );

      // Ties go to the earlier candidate: host stores, then segments.
      let oldest: Candidate | undefined;
      for (const candidate of candidates) {
        if (
          candidate.usedAt !== undefined &&
          (oldest === undefined || candidate.usedAt < oldest.usedAt!)
        ) {
          oldest = candidate;
        }
      }
      if (!oldest) {
        logger.warn('Cache is over its total with nothing left to evict', {
          overMiB: Math.round(remaining / 2 ** 20),
        });
        break;
      }
      const took = await oldest.take(Math.min(remaining, EVICT_CHUNK));
      if (took <= 0) {
        break;
      }
      oldest.add(took);
      remaining -= took;
    }

    const storesMiB: Record<string, number> = {};
    for (const name of Object.keys(stores)) {
      storesMiB[`${name}MiB`] = Math.round(
        (result.stores[name] - freed.stores[name]) / 2 ** 20,
      );
    }
    logger.info('Cache was over its total; took back the oldest of it', {
      overMiB: Math.round(over / 2 ** 20),
      ...storesMiB,
      segmentsMiB: Math.round((result.segments - freed.segments) / 2 ** 20),
      metadataMiB: Math.round((result.metadata - freed.metadata) / 2 ** 20),
    });
    return result;
  }

  private zeroPerStore(): Record<string, number> {
    const bytes: Record<string, number> = {};
    for (const name of Object.keys(this.options.stores)) {
      bytes[name] = 0;
    }
    return bytes;
  }

  private async measure(
    root: string,
    titles: Map<string, Title>,
    byTitle: boolean,
  ): Promise<{ total: number; segments: number }> {
    let total = 0;
    let segments = 0;
    const entries = (
      await readdir(root, {
        recursive: true,
        withFileTypes: true,
      }).catch(() => [])
    ).filter((entry) => entry.isFile());

    for (let i = 0; i < entries.length; i += STAT_BATCH) {
      const batch = entries.slice(i, i + STAT_BATCH);
      const measured = await Promise.all(
        batch.map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);
          const info = await stat(file).catch(() => {});
          return { name: entry.name, file, info };
        }),
      );

      for (const { name, file, info } of measured) {
        if (!info) {
          continue;
        }
        if (
          name.endsWith(TEMP_SUFFIX) &&
          Date.now() - info.mtimeMs > STALE_TEMP_MS
        ) {
          await rm(file, { force: true }).catch(() => {});
          continue;
        }
        total += info.size;
        if (isSegmentFile(name)) {
          segments += info.size;
          continue;
        }
        if (!byTitle) {
          continue;
        }

        const sourceId = path.relative(root, file).split(path.sep)[0];
        if (!sourceId) {
          continue;
        }
        const title = titles.get(sourceId) ?? {
          metadataBytes: 0,
          writtenAt: 0,
        };
        title.metadataBytes += info.size;
        // A title is as recent as its newest file.
        title.writtenAt = Math.max(title.writtenAt, info.mtimeMs);
        titles.set(sourceId, title);
      }
    }
    return { total, segments };
  }
}
