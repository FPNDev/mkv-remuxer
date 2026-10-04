import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, type Logger } from '../logger.js';
import { TEMP_SUFFIX, touchFile } from '../util/fs.js';
import { SizeLru } from '../util/lru.js';
import { isSegmentFile } from './cache-layout.js';

/**
 * LRU over finished segment files. Disk is the record: the index is rebuilt
 * from file mtimes at startup.
 */
export class SegmentCache {
  private readonly lru: SizeLru<string>;

  constructor(
    private readonly root: string,
    budgetBytes: number,
    private readonly logger: Logger,
  ) {
    this.lru = new SizeLru(budgetBytes);
  }

  get usedBytes(): number {
    return this.lru.size;
  }

  async load(): Promise<void> {
    const entries = await readdir(this.root, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    const segments: { file: string; bytes: number; mtimeMs: number }[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const file = path.join(entry.parentPath, entry.name);
      if (entry.name.endsWith(TEMP_SUFFIX)) {
        await rm(file, { force: true });
      } else if (isSegmentFile(entry.name)) {
        const info = await stat(file).catch(() => {});
        if (info) {
          segments.push({ file, bytes: info.size, mtimeMs: info.mtimeMs });
        }
      }
    }

    // Only mtime survives a restart, so it gives the LRU its starting order.
    segments.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { file, bytes, mtimeMs } of segments) {
      this.lru.set(file, bytes, mtimeMs);
    }
    await this.trim();
    this.logger.info('Segment cache loaded', {
      segments: segments.length,
      bytes: this.lru.size,
    });
  }

  async added(file: string): Promise<void> {
    const { size } = await stat(file);
    this.lru.set(file, size);
    await this.trim();
  }

  touch(file: string): void {
    this.lru.touch(file);
    touchFile(file);
  }

  // Drops bookkeeping only. The caller deletes the directory.
  forgetUnder(dir: string): void {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    for (const file of this.lru.keys()) {
      if (file.startsWith(prefix)) {
        this.lru.delete(file);
      }
    }
  }

  oldestUsedAt(): number | undefined {
    return this.lru.oldest()?.usedAt;
  }

  async evictOldest(bytes: number): Promise<number> {
    const before = this.lru.size;
    for (const file of this.lru.trimTo(Math.max(0, before - bytes))) {
      await rm(file, { force: true }).catch(() => {});
    }
    return before - this.lru.size;
  }

  private async trim(): Promise<void> {
    for (const file of this.lru.trim()) {
      await rm(file, { force: true }).catch((err: unknown) => {
        this.logger.warn('Could not delete evicted segment', {
          file,
          error: errorMessage(err),
        });
      });
    }
  }
}
