import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { AbandonedError, NotFoundError } from '../errors.js';
import type { SourceProvider } from '../io/byte-source.js';
import type { Logger } from '../logger.js';
import {
  getRenditions,
  type Rendition,
  type RenditionSet,
} from '../media/codecs.js';
import { segmentCount, type MediaIndex } from '../media/media-index.js';
import { exists, writeFileAtomic } from '../util/fs.js';
import { SingleFlight } from '../util/single-flight.js';
import {
  Priority,
  type TaskContext,
  type TaskQueue,
} from '../util/task-queue.js';
import {
  masterPlaylist,
  mediaPlaylist,
  renditionPath,
  segmentFileName,
} from './playlists.js';
import type { Remuxer } from './remux.js';

// Past this, a player is waiting on job slots rather than on download
// speed. It is logged, never enforced.
const SLOW_QUEUE_WAIT_MS = 5000;

export type AssetOptions = {
  sourceId: string;
  fileIndex: number;
  index: MediaIndex;
  layout: CacheLayout;
  provider: SourceProvider;
  segments: SegmentCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  warmSegments: number;
  logger: Logger;
};

/**
 * One (sourceId, fileIndex) pair: its media index, renditions, cache
 * directories, and the work that fills them.
 */
export class Asset {
  readonly index: MediaIndex;
  readonly renditions: RenditionSet;
  private readonly flights = new SingleFlight();

  constructor(private readonly options: AssetOptions) {
    this.index = options.index;
    this.renditions = getRenditions(options.index);
  }

  get sourceId(): string {
    return this.options.sourceId;
  }

  get fileIndex(): number {
    return this.options.fileIndex;
  }

  get segmentCount(): number {
    return segmentCount(this.index);
  }

  drop(reason: Error): void {
    for (const key of this.flights.keys()) {
      this.options.queue.abandon(key, false, reason);
    }
  }

  dirOf(rendition: Rendition): string {
    return this.options.layout.mediaFile(
      this.options.sourceId,
      this.options.fileIndex,
      renditionPath(rendition),
    );
  }

  segmentPath(rendition: Rendition, n: number): string {
    return path.join(this.dirOf(rendition), segmentFileName(rendition, n));
  }

  rendition(kind: string, track: number | undefined): Rendition {
    const found =
      kind === 'video'
        ? this.renditions.video
        : kind === 'audio'
          ? this.renditions.audio.find((audio) => audio.track.number === track)
          : this.renditions.subtitles.find(
              (subtitle) => subtitle.track.number === track,
            );
    if (!found) {
      throw new NotFoundError(
        `${this.index.fileName} has no ${kind} rendition for track ${track}`,
      );
    }
    return found;
  }

  writePlaylists(): Promise<void> {
    const { layout, sourceId, fileIndex } = this.options;

    return this.flights.run('playlists', undefined, async () => {
      for (const rendition of this.all()) {
        const dir = this.dirOf(rendition);
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(
          path.join(dir, 'index.m3u8'),
          mediaPlaylist(this.index, rendition),
        );
      }

      await writeFileAtomic(
        layout.masterFile(sourceId, fileIndex),
        masterPlaylist(this.index, this.renditions, `${sourceId}/${fileIndex}`),
      );
    });
  }

  async ensureInit(
    rendition: Rendition,
    file: string,
    priority: Priority,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new AbandonedError(`Client is no more waiting for ${file}`);
    }

    if (await exists(file)) {
      return;
    }

    await mkdir(path.dirname(file), { recursive: true });

    const { queue, remuxer } = this.options;

    if (priority === Priority.Foreground) {
      queue.promote(file);
    }

    return this.flights.run(
      file,
      signal,
      async () => {
        await queue.run(
          {
            key: file,
            priority,
          },
          ({ signal: running }) => {
            return remuxer.writeInit(this.index, rendition, file, running);
          },
        );
      },
      () => {
        queue.abandon(file);
      },
    );
  }

  async ensureSegment(
    rendition: Rendition,
    n: number,
    priority: Priority,
    signal: AbortSignal | undefined,
    stopIfNotPromoted = false,
  ): Promise<void> {
    const { queue, segments } = this.options;
    const file = this.segmentPath(rendition, n);

    if (await exists(file)) {
      segments.touch(file);
      return;
    }

    if (signal?.aborted) {
      throw new AbandonedError(`Client is not more waiting for ${file}`);
    }

    const isForeground = priority === Priority.Foreground;
    if (isForeground) {
      queue.promote(file);
    }

    queue.refreshAbandonTimer(file);

    const render = () =>
      this.flights.run(
        file,
        signal,
        () =>
          queue.run({ key: file, priority, stopIfNotPromoted }, (state) =>
            this.loadRemoteSegment(file, rendition, n, isForeground, state),
          ),
        () => {
          queue.abandon(file);
        },
      );

    try {
      await render();
    } catch (err) {
      if (err instanceof AbandonedError) {
        for (
          let i = n + 1;
          i < Math.min(n + 1 + this.options.warmSegments, this.segmentCount);
          i++
        ) {
          queue.abandon(this.segmentPath(rendition, i), true);
        }
      }

      throw err;
    }
  }

  loadRemoteSegment(
    file: string,
    rendition: Rendition,
    n: number,
    isForeground: boolean,
    { signal, waitedMs, promoted }: TaskContext,
  ) {
    const { provider, remuxer, queue, segments, logger } = this.options;

    return provider.lease(
      this.sourceId,
      this.fileIndex,
      { purpose: 'media', foreground: isForeground },
      async (source) => {
        if (signal.aborted) {
          return;
        }

        if (waitedMs > SLOW_QUEUE_WAIT_MS) {
          logger.warn('Player waited for a free job slot', {
            rendition: renditionPath(rendition),
            n,
            waitedMs,
            jobs: queue.stats,
          });
        }

        const started = Date.now();

        void promoted.then(() => {
          source.promote?.();
        });

        source.onCorrupt?.((error) => {
          void rm(file, { force: true }).catch(() => {});
          queue.abandon(file, false, error);
        });

        await mkdir(path.dirname(file), { recursive: true });

        try {
          await remuxer.writeSegment(
            { index: this.index, source, rendition, signal },
            n,
            file,
          );
        } catch (err) {
          source.release?.();
          throw err;
        }

        await segments.added(file);

        logger.debug('Rendered segment', {
          sourceId: this.sourceId,
          rendition: renditionPath(rendition),
          n,
          background: !isForeground,
          waitedMs,
          ms: Date.now() - started,
        });
      },
    );
  }

  openingTracks(): Rendition[] {
    const audio =
      this.renditions.audio.find((track) => track.track.isDefault) ??
      this.renditions.audio[0];
    return audio ? [audio, this.renditions.video] : [this.renditions.video];
  }

  eagerStart(): void {
    for (const rendition of this.openingTracks()) {
      const init = path.join(this.dirOf(rendition), 'init.mp4');
      this.ensureInit(rendition, init, Priority.Background, undefined).catch(
        () => {},
      );
      if (this.segmentCount > 0) {
        this.ensureSegment(rendition, 0, Priority.Background, undefined).catch(
          () => {},
        );
      }
    }
  }

  all(): Rendition[] {
    return [
      this.renditions.video,
      ...this.renditions.audio,
      ...this.renditions.subtitles,
    ];
  }
}
