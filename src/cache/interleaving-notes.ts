import { errorMessage, type Logger } from '../logger.js';
import { readJson, writeFileAtomic } from '../util/fs.js';
import type { CacheLayout } from './cache-layout.js';

// Notes are a hint, not state worth keeping forever.
const MAX_FILES = 4096;
const SAVE_DELAY_MS = 2000;

/**
 * Remembers which files turned out to be loosely interleaved, so a later run
 * takes the wider read path without rediscovering it.
 */
export class InterleavingNotes {
  private files: string[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly layout: CacheLayout,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<string[]> {
    this.files =
      (await readJson<string[]>(this.layout.interleavingFile())) ?? [];
    return [...this.files];
  }

  save(files: string[]): void {
    this.files = files.slice(-MAX_FILES);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void writeFileAtomic(
        this.layout.interleavingFile(),
        JSON.stringify(this.files),
      ).catch((err: unknown) => {
        this.logger.warn('Could not save interleaving notes', {
          error: errorMessage(err),
        });
      });
    }, SAVE_DELAY_MS);
    // Debounced and unref'd: a note lost at shutdown costs one rediscovery.
    this.timer.unref();
  }
}
