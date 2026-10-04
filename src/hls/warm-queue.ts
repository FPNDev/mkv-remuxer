import { errorMessage, type Logger } from '../logger.js';

// Warming is speculative, so the backlog is bounded and further requests
// are refused rather than held.
const MAX_BACKLOG = 256;

export type WarmRequest = {
  sourceId: string;
  fileIndex: number | undefined;
};

export type WarmQueueOptions = {
  concurrency: number;
  warm: (sourceId: string, fileIndex: number | undefined) => Promise<void>;
  logger: Logger;
};

export class WarmQueue {
  private readonly backlog: WarmRequest[] = [];
  private readonly running = new Set<string>();

  constructor(private readonly options: WarmQueueOptions) {}

  get pending(): number {
    return this.backlog.length;
  }

  knows(sourceId: string, fileIndex: number | undefined): boolean {
    const key = warmKey(sourceId, fileIndex);
    return (
      this.running.has(key) ||
      this.backlog.some(
        (entry) => warmKey(entry.sourceId, entry.fileIndex) === key,
      )
    );
  }

  get full(): boolean {
    return this.backlog.length >= MAX_BACKLOG;
  }

  request(sourceId: string, fileIndex: number | undefined): boolean {
    if (this.knows(sourceId, fileIndex)) {
      return false;
    }
    if (this.full) {
      this.options.logger.debug('Warm backlog is full; refused a title', {
        sourceId,
      });
      return false;
    }
    this.backlog.push({ sourceId, fileIndex });
    this.pump();
    return true;
  }

  private pump(): void {
    while (
      this.running.size < this.options.concurrency &&
      this.backlog.length > 0
    ) {
      const next = this.backlog.shift()!;
      const key = warmKey(next.sourceId, next.fileIndex);
      this.running.add(key);
      this.options
        .warm(next.sourceId, next.fileIndex)
        .catch((err: unknown) => {
          // A warm failure costs a cold first play and nothing else.
          this.options.logger.warn('Could not warm a title', {
            sourceId: next.sourceId,
            error: errorMessage(err),
          });
        })
        .finally(() => {
          this.running.delete(key);
          this.pump();
        });
    }
  }
}

// An undefined fileIndex means the default file of the source.
export function warmKey(
  sourceId: string,
  fileIndex: number | undefined,
): string {
  return `${sourceId}/${fileIndex ?? 'largest'}`;
}
