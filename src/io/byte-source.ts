import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

/** Random-access reader over a fixed-length byte range. */
export interface ByteSource {
  readonly length: number;
  /** Smallest read worth issuing; shorter ranges are widened to it. */
  readonly minReadBytes?: number;
  /** end is exclusive. */
  stream(start: number, end: number): Readable;
  /** Hint that the range will be read soon. */
  prefetch?(start: number, end: number): void;
}

/**
 * A byte source handed out for the duration of one `SourceProvider.lease`
 * call. The optional hooks let the provider react to how the read is used.
 */
export interface LeasedSource extends ByteSource {
  /** File name, checked for a Matroska or WebM extension before indexing. */
  readonly name: string;
  /** The read now serves a waiting player rather than speculative work. */
  promote?(): void;
  /** The work over this source failed; drop any state kept for it. */
  release?(): void;
  /** Reports data found to be corrupt after it was read. */
  onCorrupt?(listener: (error: Error) => void): void;
}

/**
 * Why a lease is taken. Indexing reads the file's metadata and may be
 * cancelled through `signal`; media reads render one segment.
 */
export type ReadHint =
  | { purpose: 'index'; signal: AbortSignal }
  | { purpose: 'media'; foreground: boolean };

/**
 * One file of a source. `id` is chosen by the provider and must stay the same
 * for the same file: it names the file's cache directory and URLs, so it is
 * limited to letters, digits, `_` and `-` (at most 128). Extra fields pass
 * through to `HlsService.files`.
 */
export interface SourceFile {
  id: string;
  name: string;
  length: number;
}

/** The files of a source. Extra fields pass through to `HlsService.files`. */
export interface SourceListing {
  files: SourceFile[];
}

/**
 * Supplies the bytes behind a `sourceId`. The remuxer never opens files or
 * connections itself; every read goes through a lease.
 */
export interface SourceProvider {
  list(sourceId: string): Promise<SourceListing>;
  /** Runs `work` over file `fileId`, keeping the source open meanwhile. */
  lease<T>(
    sourceId: string,
    fileId: string,
    hint: ReadHint,
    work: (source: LeasedSource) => Promise<T>,
  ): Promise<T>;
  /** A request for this source arrived. */
  touch?(sourceId: string): void;
  /** Background warming for this source is about to start. */
  warm?(sourceId: string): void;
  /** Sources currently in use; their cached metadata is never evicted. */
  active?(): Set<string>;
}

// Views the chunk's memory rather than copying it, so the result is only safe
// to read.
export function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/** Collects a whole range in memory. Stream instead when the range is large. */
export async function readRange(
  source: ByteSource,
  start: number,
  end: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source.stream(start, end)) {
    chunks.push(asBuffer(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export class LocalFileSource implements ByteSource {
  private constructor(
    readonly path: string,
    readonly length: number,
  ) {}

  stream(start: number, end: number): Readable {
    if (end <= start) {
      return Readable.from([]);
    }
    // createReadStream's end is inclusive.
    return createReadStream(this.path, { start, end: end - 1 });
  }
}
