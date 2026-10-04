type Entry = {
  bytes: number;
  usedAt: number;
};

/**
 * Byte-budgeted LRU. Map iteration order is insertion order, so the head is
 * the least recently used entry and touch() re-inserts to move a key to the tail.
 */
export class SizeLru<K> {
  private readonly entries = new Map<K, Entry>();
  private totalBytes = 0;

  constructor(private readonly budgetBytes: number) {}

  get size(): number {
    return this.totalBytes;
  }

  set(key: K, bytes: number, usedAt = Date.now()): void {
    this.delete(key);
    this.entries.set(key, { bytes, usedAt });
    this.totalBytes += bytes;
  }

  resize(key: K, bytes: number): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.totalBytes += bytes - entry.bytes;
    entry.bytes = bytes;
  }

  touch(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    entry.usedAt = Date.now();
    this.entries.set(key, entry);
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    return true;
  }

  oldest(
    isPinned: (key: K) => boolean = () => false,
  ): { key: K; bytes: number; usedAt: number } | undefined {
    for (const [key, entry] of this.entries) {
      if (!isPinned(key)) {
        return { key, bytes: entry.bytes, usedAt: entry.usedAt };
      }
    }
    return undefined;
  }

  /**
   * Evicts from the head until the byte budget holds and returns the evicted
   * keys. Pinned keys are skipped, so the total can stay above budget.
   */
  trim(isPinned: (key: K) => boolean = () => false): K[] {
    return this.trimTo(this.budgetBytes, isPinned);
  }

  trimTo(limit: number, isPinned: (key: K) => boolean = () => false): K[] {
    const removed: K[] = [];
    for (const [key, entry] of this.entries) {
      if (this.totalBytes <= limit) {
        break;
      }
      if (isPinned(key)) {
        continue;
      }
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
      removed.push(key);
    }
    return removed;
  }
}
