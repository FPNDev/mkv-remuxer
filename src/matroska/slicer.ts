import { asBuffer } from '../io/byte-source.js';
import {
  encodeElement,
  encodeId,
  encodeUint,
  MatroskaError,
  readElementHeader,
  readVint,
  UNKNOWN_SIZE,
  UNKNOWN_SIZE_VINT,
  vintLength,
  type ElementHeader,
} from './ebml.js';
import { Id, TOP_LEVEL_IDS } from './ids.js';

/**
 * keyframes cuts between two exact video keyframe timestamps taken from the
 * cue index; a null bound runs to the start or end of the input. time cuts on
 * the selected track's own timestamps, for tracks with no keyframes.
 */
export type SliceRange =
  | {
      mode: 'keyframes';
      startKeyframe: number | null;
      endKeyframe: number | null;
    }
  | { mode: 'time'; from: number; to: number | null };

export type SliceOptions = {
  header: Buffer;
  track: number;
  videoTrack: number;
  range: SliceRange;
};

export type SliceResult = {
  blocks: number;
  started: boolean;
  reachedEnd: boolean;
  sourceEnded: boolean;
  firstTrackTs: number | null;
  timestamps: number[];
};

// A block header fits in far less than this. Peeking first keeps blocks of
// other tracks out of memory: they are skipped, never buffered.
const BLOCK_PEEK = 64;
// Sanity bound. A corrupt size field would otherwise buffer without end.
const MAX_ELEMENT_SIZE = 256 * 1024 * 1024;

// Emitted when a slice matched no block, so ffmpeg still gets a valid file.
export const EMPTY_CLUSTER = encodeElement(
  Id.Cluster,
  encodeElement(Id.Timestamp, encodeUint(0)),
);

/**
 * Header for a single-track stream: the source EBML header and Info, one
 * TrackEntry, and a Segment of unknown size because the length of a slice is
 * not known before it is cut.
 */
export function buildTrackHeader(
  ebmlHeader: Buffer,
  info: Buffer,
  trackEntry: Buffer,
): Buffer {
  return Buffer.concat([
    ebmlHeader,
    encodeId(Id.Segment),
    UNKNOWN_SIZE_VINT,
    info,
    encodeElement(Id.Tracks, trackEntry),
  ]);
}

export function sliceMatroska(
  source: AsyncIterable<Uint8Array>,
  options: SliceOptions,
): { stream: AsyncGenerator<Buffer>; result: SliceResult } {
  const result: SliceResult = {
    blocks: 0,
    started: false,
    reachedEnd: false,
    sourceEnded: false,
    firstTrackTs: null,
    timestamps: [],
  };
  return { result, stream: generate(source, options, result) };
}

async function* generate(
  source: AsyncIterable<Uint8Array>,
  { header, track, videoTrack, range }: SliceOptions,
  result: SliceResult,
): AsyncGenerator<Buffer> {
  const iterator = source[Symbol.asyncIterator]();
  const input = new ByteQueue(iterator);

  let started = range.mode === 'time' || range.startKeyframe === null;
  result.started = started;

  let inCluster = false;
  let clusterEnd = Infinity;
  let clusterTs: number | undefined;
  let clusterOpened = false;

  try {
    yield header;

    while (await input.fill(1)) {
      await input.fill(12);
      const element = readElementHeader(input.peek(12), 0);
      if (!element) {
        break;
      }

      if (inCluster && input.position >= clusterEnd) {
        inCluster = false;
      }

      if (element.id === Id.Cluster) {
        input.take(element.headerLength);
        inCluster = true;
        clusterEnd =
          element.size === UNKNOWN_SIZE
            ? Infinity
            : input.position + element.size;
        clusterTs = undefined;
        clusterOpened = false;
        continue;
      }
      // Cues, Tags or another level-1 element: the clusters are done.
      if (TOP_LEVEL_IDS.has(element.id)) {
        break;
      }

      if (element.size === UNKNOWN_SIZE) {
        throw new MatroskaError('Unsized element inside cluster data');
      }
      const total = element.headerLength + element.size;
      const isBlock =
        element.id === Id.SimpleBlock || element.id === Id.BlockGroup;

      if (!inCluster || (!isBlock && element.id !== Id.Timestamp)) {
        if (!(await input.skip(total))) {
          break;
        }
        continue;
      }

      if (element.id === Id.Timestamp) {
        if (!(await input.fill(total))) {
          break;
        }
        clusterTs = readUintBytes(input.take(total), element.headerLength);
        continue;
      }

      if (clusterTs === undefined) {
        throw new MatroskaError('Block found before its cluster timestamp');
      }
      if (total > MAX_ELEMENT_SIZE) {
        throw new MatroskaError(
          `Block of ${total} bytes exceeds the size limit`,
        );
      }

      const peekLength = Math.min(total, BLOCK_PEEK);
      if (!(await input.fill(peekLength))) {
        break;
      }
      let block = parseBlockHeader(input.peek(peekLength), element);
      if (!block) {
        if (!(await input.fill(total))) {
          break;
        }
        block = parseBlockHeader(input.peek(total), element);
        if (!block) {
          throw new MatroskaError('Malformed block header');
        }
      }
      const ts = clusterTs + block.relativeTs;
      if (block.track === track && result.firstTrackTs === null) {
        result.firstTrackTs = ts;
      }

      let emit: boolean;
      if (range.mode === 'keyframes') {
        const isVideo = block.track === videoTrack;
        if (!started) {
          // Cue times are exact block timestamps, so equality is the
          // right test.
          started = isVideo && ts === range.startKeyframe;
          result.started = started;
        } else if (isVideo && ts === range.endKeyframe) {
          result.reachedEnd = true;
          break;
        }
        emit = started && block.track === track;
      } else {
        if (block.track === track && range.to !== null && ts >= range.to) {
          result.reachedEnd = true;
          break;
        }
        emit = block.track === track && ts >= range.from;
      }

      if (!emit) {
        if (!(await input.skip(total))) {
          break;
        }
        continue;
      }
      if (!(await input.fill(total))) {
        break;
      }

      // Copy the source cluster timestamp so block timestamps stay meaningful.
      // Size is unknown: the blocks that will match are not known yet.
      if (!clusterOpened) {
        clusterOpened = true;
        yield Buffer.concat([
          encodeId(Id.Cluster),
          UNKNOWN_SIZE_VINT,
          encodeElement(Id.Timestamp, encodeUint(clusterTs)),
        ]);
      }
      result.blocks++;
      result.timestamps.push(ts);
      yield input.take(total);
    }

    if (result.blocks === 0) {
      yield EMPTY_CLUSTER;
    }
  } finally {
    result.sourceEnded = input.ended;
    await iterator.return?.();
  }
}

function readUintBytes(buf: Buffer, start: number): number {
  let value = 0;
  for (let i = start; i < buf.length; i++) {
    value = value * 256 + buf[i]!;
  }
  return value;
}

/**
 * Reads track number and cluster-relative timestamp from a SimpleBlock or the
 * Block inside a BlockGroup. Returns null when buf is too short, so the caller
 * can retry with the whole element.
 */
function parseBlockHeader(
  buf: Buffer,
  element: ElementHeader,
): { track: number; relativeTs: number } | null {
  let pos = element.headerLength;

  if (element.id === Id.BlockGroup) {
    const end = element.headerLength + element.size;
    let cursor = element.headerLength;
    pos = -1;
    while (cursor < end && cursor < buf.length) {
      const child = readElementHeader(buf, cursor);
      if (!child) {
        return null;
      }
      if (child.size === UNKNOWN_SIZE) {
        throw new MatroskaError('Unsized element inside BlockGroup');
      }
      if (child.id === Id.Block) {
        pos = cursor + child.headerLength;
        break;
      }
      cursor += child.headerLength + child.size;
    }
    if (pos === -1) {
      if (cursor >= end) {
        throw new MatroskaError('BlockGroup without a Block');
      }
      return null;
    }
  }

  if (pos >= buf.length) {
    return null;
  }
  const trackLength = vintLength(buf[pos]!);
  if (pos + trackLength + 2 > buf.length) {
    return null;
  }

  return {
    track: readVint(buf, pos).value,
    // Signed 16-bit offset from the cluster timestamp.
    relativeTs: buf.readInt16BE(pos + trackLength),
  };
}

class ByteQueue {
  private readonly chunks: Buffer[] = [];
  private head = 0;
  ended = false;
  length = 0;
  position = 0;

  constructor(private readonly source: AsyncIterator<Uint8Array>) {}

  async fill(n: number): Promise<boolean> {
    while (this.length < n) {
      if (this.ended) {
        return false;
      }
      const next = await this.source.next();
      if (next.done) {
        this.ended = true;
        return false;
      }
      const chunk = asBuffer(next.value);
      if (chunk.length === 0) {
        continue;
      }
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    return true;
  }

  peek(n: number): Buffer {
    return this.copy(Math.min(n, this.length));
  }

  take(n: number): Buffer {
    const out = this.copy(n);
    this.consume(n);
    return out;
  }

  async skip(n: number): Promise<boolean> {
    let rest = n;
    while (rest > 0) {
      if (this.length === 0 && !(await this.fill(1))) {
        return false;
      }
      const step = Math.min(rest, this.length);
      this.consume(step);
      rest -= step;
    }
    return true;
  }

  // Returns a view while the bytes sit in one chunk and only copies across a
  // chunk boundary.
  private copy(n: number): Buffer {
    const first = this.chunks[0];
    if (!first || n === 0) {
      return Buffer.alloc(0);
    }
    if (first.length - this.head >= n) {
      return first.subarray(this.head, this.head + n);
    }

    const out = Buffer.allocUnsafe(n);
    let written = 0;
    for (let i = 0, offset = this.head; written < n; i++, offset = 0) {
      const chunk = this.chunks[i]!;
      const end = Math.min(chunk.length, offset + n - written);
      written += chunk.copy(out, written, offset, end);
    }
    return out;
  }

  private consume(n: number): void {
    this.length -= n;
    this.position += n;
    let rest = n;
    while (rest > 0) {
      const chunk = this.chunks[0]!;
      const available = chunk.length - this.head;
      if (available > rest) {
        this.head += rest;
        return;
      }
      rest -= available;
      this.chunks.shift();
      this.head = 0;
    }
  }
}
