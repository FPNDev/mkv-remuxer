import { errorMessage, type Logger } from '../logger.js';

// Warming is speculative, so the backlog is bounded and further requests
// are refused rather than held.
const MAX_BACKLOG = 256;

export type WarmRequest = {
  sourceId: string;
  fileId: string | undefined;
};

export type WarmQueueOptions = {
  concurrency: number;
  warm: (sourceId: string, fileId: string | undefined) => Promise<void>;
  logger: Logger;
};

export class WarmQueue {
  private readonly backlog: WarmRequest[] = [];
  private readonly running = new Set<string>();

  constructor(private readonly options: WarmQueueOptions) {}

  get pending(): number {
    return this.backlog.length;
  }

  knows(sourceId: string, fileId: string | undefined): boolean {
    const key = warmKey(sourceId, fileId);
    return (
      this.running.has(key) ||
      this.backlog.some(
        (entry) => warmKey(entry.sourceId, entry.fileId) === key,
      )
    );
  }

  get full(): boolean {
    return this.backlog.length >= MAX_BACKLOG;
  }

  request(sourceId: string, fileId: string | undefined): boolean {
    if (this.knows(sourceId, fileId)) {
      return false;
    }
    if (this.full) {
      this.options.logger.debug('Warm backlog is full; refused a title', {
        sourceId,
      });
      return false;
    }
    this.backlog.push({ sourceId, fileId });
    this.pump();
    return true;
  }

  private pump(): void {
    while (
      this.running.size < this.options.concurrency &&
      this.backlog.length > 0
    ) {
      const next = this.backlog.shift()!;
      const key = warmKey(next.sourceId, next.fileId);
      this.running.add(key);
      this.options
        .warm(next.sourceId, next.fileId)
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

// An undefined fileId means the default file of the source. A colon never
// appears in an id, so the key cannot clash with a real file.
function warmKey(sourceId: string, fileId: string | undefined): string {
  return `${sourceId}/${fileId ?? ':default'}`;
}
