import { asBuffer, type ByteSource } from '../io/byte-source.js';
import {
  childElements,
  encodeElement,
  encodeId,
  encodeUint,
  MatroskaError,
  readElementHeader,
  readVint,
  UNKNOWN_SIZE,
  UNKNOWN_SIZE_VINT,
  vintLength,
  type EbmlElement,
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

/** carried: clusters emitted right after the header, ahead of the slice. */
export type SliceOptions = {
  header: Buffer;
  track: number;
  videoTrack: number;
  range: SliceRange;
  carried?: Buffer[] | undefined;
};

export type SliceResult = {
  blocks: number;
  started: boolean;
  reachedEnd: boolean;
  sourceEnded: boolean;
  firstTrackTs: number | null;
  timestamps: number[];
  /** Frame data bytes of each emitted block, lacing included. */
  sizes: number[];
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
    sizes: [],
  };

  return { result, stream: generate(source, options, result) };
}

async function* generate(
  source: AsyncIterable<Uint8Array>,
  { header, track, videoTrack, range, carried = [] }: SliceOptions,
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
    for (const cluster of carried) {
      yield cluster;
    }

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
      result.sizes.push(block.dataSize);
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

/** ts is the block timestamp in ticks; frame the first frame of the block. */
export type FirstBlock = {
  ts: number;
  frame: Buffer;
};

/**
 * blocks holds the first block of each wanted track, video the timestamps of
 * the first video blocks in file order.
 */
export type FirstBlocks = {
  blocks: Map<number, FirstBlock>;
  video: number[];
};

/**
 * Walks the clusters of `source` for the first block of each track in
 * `tracks` and the timestamps of the first `frames` blocks of `videoTrack`.
 * Tracks without a block in the input are missing from the result.
 */
export async function firstBlocks(
  source: AsyncIterable<Uint8Array>,
  tracks: Set<number>,
  videoTrack: number,
  frames: number,
): Promise<FirstBlocks> {
  const found = new Map<number, FirstBlock>();
  const video: number[] = [];
  const iterator = source[Symbol.asyncIterator]();
  const input = new ByteQueue(iterator);
  let clusterTs: number | undefined;

  try {
    while (
      (found.size < tracks.size || video.length < frames) &&
      (await input.fill(1))
    ) {
      await input.fill(12);
      const element = readElementHeader(input.peek(12), 0);
      if (!element) {
        break;
      }
      if (element.id === Id.Cluster) {
        input.take(element.headerLength);
        clusterTs = undefined;
        continue;
      }
      if (element.size === UNKNOWN_SIZE) {
        // A level-1 element of unknown size other than a Cluster: no blocks.
        break;
      }
      const total = element.headerLength + element.size;
      const isBlock =
        element.id === Id.SimpleBlock || element.id === Id.BlockGroup;

      if (element.id === Id.Timestamp) {
        if (!(await input.fill(total))) {
          break;
        }
        clusterTs = readUintBytes(input.take(total), element.headerLength);
        continue;
      }
      if (!isBlock || clusterTs === undefined || total > MAX_ELEMENT_SIZE) {
        if (!(await input.skip(total))) {
          break;
        }
        continue;
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
      }
      if (block?.track === videoTrack && video.length < frames) {
        video.push(clusterTs + block.relativeTs);
      }
      if (!block || !tracks.has(block.track) || found.has(block.track)) {
        if (!(await input.skip(total))) {
          break;
        }
        continue;
      }
      if (!(await input.fill(total))) {
        break;
      }
      const frame = firstFrame(input.take(total), element);
      if (frame) {
        found.set(block.track, { ts: clusterTs + block.relativeTs, frame });
      }
    }
  } finally {
    await iterator.return?.();
  }

  return { blocks: found, video };
}

/**
 * Where a block sits: the absolute offset of its cluster, its own offset in
 * the cluster data when known, and where the readable data ends.
 */
export type BlockPosition = {
  cluster: number;
  rel: number | undefined;
  end: number;
};

/**
 * The block of `track` at tick `ts`, in a cluster of its own that keeps the
 * source cluster timestamp. Without rel the cluster is walked up to the
 * block. undefined when the block is not there.
 */
export async function blockCluster(
  source: ByteSource,
  { cluster, rel, end }: BlockPosition,
  track: number,
  ts: number,
): Promise<Buffer | undefined> {
  const iterator = source
    .stream(cluster, end)
    [Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
  const input = new ByteQueue(iterator);
  try {
    await input.fill(12);
    const head = readElementHeader(input.peek(12), 0);
    if (head?.id !== Id.Cluster) {
      return undefined;
    }
    input.take(head.headerLength);
    const clusterEnd =
      head.size === UNKNOWN_SIZE ? Infinity : head.headerLength + head.size;
    let clusterTs: number | undefined;

    while (input.position < clusterEnd && (await input.fill(1))) {
      await input.fill(12);
      const element = readElementHeader(input.peek(12), 0);
      if (
        !element ||
        element.size === UNKNOWN_SIZE ||
        TOP_LEVEL_IDS.has(element.id)
      ) {
        return undefined;
      }
      const total = element.headerLength + element.size;
      if (element.id === Id.Timestamp) {
        if (!(await input.fill(total))) {
          return undefined;
        }
        clusterTs = readUintBytes(input.take(total), element.headerLength);
        if (rel !== undefined) {
          const block = await blockAt(
            source,
            cluster + head.headerLength + rel,
            end,
            track,
            ts - clusterTs,
          );

          return block && clusterOf(clusterTs, block);
        }
        continue;
      }
      const isBlock =
        element.id === Id.SimpleBlock || element.id === Id.BlockGroup;
      if (!isBlock || clusterTs === undefined || total > MAX_ELEMENT_SIZE) {
        if (!(await input.skip(total))) {
          return undefined;
        }
        continue;
      }
      const peekLength = Math.min(total, BLOCK_PEEK);
      if (!(await input.fill(peekLength))) {
        return undefined;
      }
      const block =
        parseBlockHeader(input.peek(peekLength), element) ??
        ((await input.fill(total))
          ? parseBlockHeader(input.peek(total), element)
          : null);
      if (block?.track === track && clusterTs + block.relativeTs === ts) {
        return (await input.fill(total))
          ? clusterOf(clusterTs, Buffer.from(input.take(total)))
          : undefined;
      }
      if (!(await input.skip(total))) {
        return undefined;
      }
    }

    return undefined;
  } finally {
    await iterator.return?.();
  }
}

// The block element that starts at `start`, when it is of `track` at
// `relativeTs` from its cluster timestamp.
async function blockAt(
  source: ByteSource,
  start: number,
  end: number,
  track: number,
  relativeTs: number,
): Promise<Buffer | undefined> {
  const iterator = source
    .stream(start, end)
    [Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
  const input = new ByteQueue(iterator);
  try {
    await input.fill(12);
    const element = readElementHeader(input.peek(12), 0);
    if (
      !element ||
      (element.id !== Id.SimpleBlock && element.id !== Id.BlockGroup) ||
      element.size === UNKNOWN_SIZE
    ) {
      return undefined;
    }
    const total = element.headerLength + element.size;
    if (total > MAX_ELEMENT_SIZE || !(await input.fill(total))) {
      return undefined;
    }
    const block = parseBlockHeader(input.peek(total), element);
    if (block?.track !== track || block.relativeTs !== relativeTs) {
      return undefined;
    }

    return Buffer.from(input.take(total));
  } finally {
    await iterator.return?.();
  }
}

function clusterOf(clusterTs: number, block: Buffer): Buffer {
  return encodeElement(
    Id.Cluster,
    Buffer.concat([encodeElement(Id.Timestamp, encodeUint(clusterTs)), block]),
  );
}

// The first frame of a SimpleBlock or BlockGroup, past any lacing header.
function firstFrame(buf: Buffer, element: ElementHeader): Buffer | undefined {
  let pos = element.headerLength;
  let end = buf.length;
  if (element.id === Id.BlockGroup) {
    let block: EbmlElement | undefined;
    for (const child of childElements(buf, pos, end)) {
      if (child.id === Id.Block) {
        block = child;
        break;
      }
    }
    if (!block) {
      return undefined;
    }
    pos = block.dataStart;
    end = block.dataEnd;
  }
  pos += vintLength(buf[pos]!) + 2;
  const flags = buf[pos++]!;
  const lacing = (flags >> 1) & 3;
  if (lacing === 0) {
    return buf.subarray(pos, end);
  }

  const count = buf[pos++]! + 1;
  if (lacing === 2) {
    return buf.subarray(pos, pos + (end - pos) / count);
  }
  let size = 0;
  if (lacing === 1) {
    // Xiph: every size but the last as a run of 255s ended by a smaller byte.
    for (let frame = 0; frame < count - 1; frame++) {
      let lace = 0;
      let byte = 255;
      while (byte === 255) {
        byte = buf[pos++]!;
        lace += byte;
      }
      if (frame === 0) {
        size = lace;
      }
    }
  } else {
    // EBML: the first size as a vint, then signed differences.
    const first = readVint(buf, pos);
    size = first.value;
    pos += first.length;
    for (let frame = 1; frame < count - 1; frame++) {
      pos += readVint(buf, pos).length;
    }
  }

  return buf.subarray(pos, Math.min(end, pos + size));
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
 * Block inside a BlockGroup, and the size of the frame data that follows the
 * block header. Returns null when buf is too short, so the caller can retry
 * with the whole element.
 */
function parseBlockHeader(
  buf: Buffer,
  element: ElementHeader,
): { track: number; relativeTs: number; dataSize: number } | null {
  let pos = element.headerLength;
  let blockEnd = element.headerLength + element.size;

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
        blockEnd = pos + child.size;
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
    // Past the timestamp and the flags byte.
    dataSize: blockEnd - pos - trackLength - 3,
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
