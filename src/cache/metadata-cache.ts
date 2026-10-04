import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, type Logger } from '../logger.js';
import { touchFile } from '../util/fs.js';
import { SizeLru } from '../util/lru.js';
import { isSegmentFile, type CacheLayout } from './cache-layout.js';

// The marker file's mtime carries use order across restarts. Bump it at most
// this often: every touch costs a syscall.
const MARK_INTERVAL_MS = 60_000;

export type MetadataCacheOptions = {
  logger: Logger;
  hostDataDir?: string | undefined;
  markerFile?: ((sourceId: string) => string) | undefined;
};

/**
 * LRU over everything cached for a title except its segments: host data,
 * index and playlists. Dropping a title makes the next request rebuild them,
 * not the media.
 */
export class MetadataCache {
  private readonly lru: SizeLru<string>;
  private readonly marked = new Map<string, number>();

  constructor(
    private readonly layout: CacheLayout,
    budgetBytes: number,
    private readonly options: MetadataCacheOptions,
  ) {
    this.lru = new SizeLru(budgetBytes);
  }

  get usedBytes(): number {
    return this.lru.size;
  }

  note(sourceId: string, bytes: number, writtenAt: number): void {
    // A title that grows keeps its place in the order; only a new one enters at
    // the time it was written.
    if (this.lru.has(sourceId)) {
      this.lru.resize(sourceId, bytes);
    } else {
      this.lru.set(sourceId, bytes, writtenAt);
    }
  }

  touch(sourceId: string): void {
    this.lru.touch(sourceId);
    const now = Date.now();
    if (now - (this.marked.get(sourceId) ?? 0) < MARK_INTERVAL_MS) {
      return;
    }
    this.marked.set(sourceId, now);
    if (this.options.markerFile) {
      touchFile(this.options.markerFile(sourceId));
    }
  }

  keepOnly(present: Set<string>): void {
    for (const sourceId of this.lru.keys()) {
      if (!present.has(sourceId)) {
        this.lru.delete(sourceId);
        this.marked.delete(sourceId);
      }
    }
  }

  oldestUsedAt(isPinned: (sourceId: string) => boolean): number | undefined {
    return this.lru.oldest(isPinned)?.usedAt;
  }

  trimToBudget(isPinned: (sourceId: string) => boolean): Promise<number> {
    const before = this.lru.size;
    return this.remove(this.lru.trim(isPinned), before);
  }

  evictOldest(
    bytes: number,
    isPinned: (sourceId: string) => boolean,
  ): Promise<number> {
    const before = this.lru.size;
    const target = Math.max(0, before - bytes);
    return this.remove(this.lru.trimTo(target, isPinned), before);
  }

  private async remove(sourceIds: string[], before: number): Promise<number> {
    for (const sourceId of sourceIds) {
      await this.deleteMetadata(sourceId);
      this.options.logger.info('Dropped the least recently used title', {
        sourceId,
      });
    }
    return before - this.lru.size;
  }

  // Leaves numbered segments behind for SegmentCache to account for and evict.
  private async deleteMetadata(sourceId: string): Promise<void> {
    const drop = async (file: string): Promise<void> => {
      await rm(file, { force: true, recursive: true }).catch((err: unknown) => {
        this.options.logger.warn('Could not delete cached metadata', {
          file,
          error: errorMessage(err),
        });
      });
    };

    if (this.options.hostDataDir) {
      await drop(path.join(this.options.hostDataDir, sourceId));
    }
    const media = path.join(this.layout.hlsDir, sourceId);
    const entries = await readdir(media, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && !isSegmentFile(entry.name)) {
        await drop(path.join(entry.parentPath, entry.name));
      }
    }
  }
}
