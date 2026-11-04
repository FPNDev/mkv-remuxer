import { Transform, type TransformCallback } from 'node:stream';

// Every output timestamp is shifted by this much, so a segment whose first
// frame precedes its own start still carries non-negative times.
export const TIMELINE_OFFSET_SECONDS = 10;

const INIT_BOXES = new Set(['ftyp', 'moov']);
const MEDIA_BOXES = new Set(['moof', 'mdat']);

/**
 * Splits ffmpeg's fragmented MP4 stream. ftyp and moov collect into the
 * init segment, moof and mdat pass through, other top-level boxes drop.
 */
export class Fmp4Splitter extends Transform {
  private readonly initChunks: Buffer[] = [];
  private header = Buffer.alloc(0);
  private remaining = 0;
  private route: 'init' | 'media' | 'drop' = 'drop';

  get init(): Buffer {
    return Buffer.concat(this.initChunks);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining === 0) {
          offset = this.readHeader(chunk, offset);
          continue;
        }
        const end = Math.min(chunk.length, offset + this.remaining);
        this.forward(chunk.subarray(offset, end));
        this.remaining -= end - offset;
        offset = end;
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    // A part-read header or an unfinished box means ffmpeg died mid-write.
    const truncated =
      this.header.length > 0 ||
      (this.remaining > 0 && this.remaining !== Infinity);
    callback(truncated ? new Error('Truncated MP4 output') : null);
  }

  private readHeader(chunk: Buffer, offset: number): number {
    const largeSize =
      this.header.length >= 8 && this.header.readUInt32BE(0) === 1;
    const wanted = (largeSize ? 16 : 8) - this.header.length;
    const taken = Math.min(wanted, chunk.length - offset);
    this.header = Buffer.concat([
      this.header,
      chunk.subarray(offset, offset + taken),
    ]);
    offset += taken;

    if (this.header.length < 8) {
      return offset;
    }
    const size32 = this.header.readUInt32BE(0);
    if (size32 === 1 && this.header.length < 16) {
      return offset;
    }

    // Size 1 means the true 64-bit size follows the box type; size 0 means
    // the box runs to end of stream.
    const headerLength = size32 === 1 ? 16 : 8;
    const size =
      size32 === 1
        ? Number(this.header.readBigUInt64BE(8))
        : size32 === 0
          ? Infinity
          : size32;
    if (size < headerLength) {
      throw new Error('Invalid MP4 box size');
    }

    const type = this.header.toString('latin1', 4, 8);
    this.route = INIT_BOXES.has(type)
      ? 'init'
      : MEDIA_BOXES.has(type)
        ? 'media'
        : 'drop';
    this.forward(this.header);
    this.remaining = size - headerLength;
    this.header = Buffer.alloc(0);

    return offset;
  }

  private forward(bytes: Buffer): void {
    if (this.route === 'media') {
      this.push(bytes);
    } else if (this.route === 'init') {
      this.initChunks.push(bytes);
    }
  }
}

// Walks top-level boxes only, and answers false rather than throwing when
// a size is too small to advance the walk.
export function hasTopLevelBox(buf: Buffer, type: string): boolean {
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const size = buf.readUInt32BE(pos);
    if (buf.toString('latin1', pos + 4, pos + 8) === type) {
      return true;
    }
    if (size < 8) {
      return false;
    }
    pos += size;
  }

  return false;
}

type Box = {
  start: number;
  end: number;
};

function findBox(buf: Buffer, path: string[]): Box {
  let box: Box = { start: 0, end: buf.length };
  for (const type of path) {
    let pos = box.start;
    let found: Box | undefined;
    while (pos + 8 <= box.end) {
      const size = buf.readUInt32BE(pos);
      if (size < 8) {
        break;
      }
      if (buf.toString('latin1', pos + 4, pos + 8) === type) {
        found = { start: pos + 8, end: pos + size };
        break;
      }
      pos += size;
    }
    if (!found) {
      throw new Error(`MP4 box ${path.join('/')} not found`);
    }
    box = found;
  }

  return box;
}

export function trackTimescale(init: Buffer): number {
  const { start } = findBox(init, ['moov', 'trak', 'mdia', 'mdhd']);

  return init.readUInt32BE(start + (init[start] === 1 ? 20 : 12));
}

// The child boxes of a visual sample entry follow 78 bytes of its own fields.
const VISUAL_ENTRY_FIELDS = 78;

/**
 * Appends a `type` box to the first sample entry of a video init segment,
 * unless the entry already has one.
 */
export function addSampleEntryBox(
  init: Buffer,
  type: string,
  payload: Buffer,
): Buffer {
  const path = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'];
  const headers: number[] = [];
  for (const i of path.keys()) {
    headers.push(findBox(init, path.slice(0, i + 1)).start - 8);
  }
  // Past the stsd header, its version and flags, and its entry count.
  const entry = headers.at(-1)! + 16;
  const entryEnd = entry + init.readUInt32BE(entry);
  let pos = entry + 8 + VISUAL_ENTRY_FIELDS;
  while (pos + 8 <= entryEnd) {
    if (init.toString('latin1', pos + 4, pos + 8) === type) {
      return init;
    }
    const size = init.readUInt32BE(pos);
    if (size < 8) {
      break;
    }
    pos += size;
  }

  const added = box(type, payload);
  const out = Buffer.concat([
    init.subarray(0, entryEnd),
    added,
    init.subarray(entryEnd),
  ]);
  headers.push(entry);
  for (const header of headers) {
    out.writeUInt32BE(out.readUInt32BE(header) + added.length, header);
  }

  return out;
}

/**
 * One sample of a fragment. dts and duration are in the track timescale;
 * compositionOffset is the presentation time minus dts.
 */
export type FragmentSample = {
  dts: number;
  duration: number;
  flags: number;
  data: Buffer;
  compositionOffset?: number;
};

/** The samples of every fragment in `buf`. */
export function readFragments(buf: Buffer): FragmentSample[] {
  const samples: FragmentSample[] = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const size = buf.readUInt32BE(pos);
    if (size < 8) {
      break;
    }
    if (buf.toString('latin1', pos + 4, pos + 8) === 'moof') {
      readMoof(buf, pos, buf.subarray(pos, pos + size), samples);
    }
    pos += size;
  }

  return samples;
}

function readMoof(
  buf: Buffer,
  moofStart: number,
  moof: Buffer,
  samples: FragmentSample[],
): void {
  const tfhd = findBox(moof, ['moof', 'traf', 'tfhd']).start;
  const tfhdFlags = moof.readUIntBE(tfhd + 1, 3);
  let at = tfhd + 8;
  let base = moofStart;
  if (tfhdFlags & 0x1) {
    base = Number(moof.readBigUInt64BE(at));
    at += 8;
  }
  if (tfhdFlags & 0x2) {
    at += 4;
  }
  let defaultDuration = 0;
  let defaultSize = 0;
  let defaultFlags = 0;
  if (tfhdFlags & 0x8) {
    defaultDuration = moof.readUInt32BE(at);
    at += 4;
  }
  if (tfhdFlags & 0x10) {
    defaultSize = moof.readUInt32BE(at);
    at += 4;
  }
  if (tfhdFlags & 0x20) {
    defaultFlags = moof.readUInt32BE(at);
  }

  const tfdt = findBox(moof, ['moof', 'traf', 'tfdt']).start;
  let dts =
    moof[tfdt] === 1
      ? Number(moof.readBigUInt64BE(tfdt + 4))
      : moof.readUInt32BE(tfdt + 4);

  const trun = findBox(moof, ['moof', 'traf', 'trun']).start;
  const flags = moof.readUIntBE(trun + 1, 3);
  const count = moof.readUInt32BE(trun + 4);
  at = trun + 8;
  let offset = base;
  if (flags & 0x1) {
    offset += moof.readInt32BE(at);
    at += 4;
  }
  let firstFlags: number | undefined;
  if (flags & 0x4) {
    firstFlags = moof.readUInt32BE(at);
    at += 4;
  }
  for (let i = 0; i < count; i++) {
    let duration = defaultDuration;
    let size = defaultSize;
    let sampleFlags = i === 0 ? (firstFlags ?? defaultFlags) : defaultFlags;
    if (flags & 0x100) {
      duration = moof.readUInt32BE(at);
      at += 4;
    }
    if (flags & 0x200) {
      size = moof.readUInt32BE(at);
      at += 4;
    }
    if (flags & 0x400) {
      sampleFlags = moof.readUInt32BE(at);
      at += 4;
    }
    if (flags & 0x800) {
      at += 4;
    }
    samples.push({
      dts,
      duration,
      flags: sampleFlags,
      data: buf.subarray(offset, offset + size),
    });
    offset += size;
    dts += duration;
  }
}

// ffmpeg numbers the only track of its output 1.
const TRACK_ID = 1;

/**
 * A moof and mdat holding `samples`, the first one decoded at baseTime.
 * Composition offsets, when the samples carry them, are written signed.
 */
export function writeFragment(
  baseTime: number,
  samples: FragmentSample[],
): Buffer {
  const offsets = samples.some(
    (sample) => sample.compositionOffset !== undefined,
  );
  const entrySize = offsets ? 16 : 12;
  const entries = Buffer.alloc(samples.length * entrySize);
  const mdat: Buffer[] = [Buffer.alloc(8)];
  let mdatSize = 8;
  for (const [i, sample] of samples.entries()) {
    const at = i * entrySize;
    entries.writeUInt32BE(sample.duration, at);
    entries.writeUInt32BE(sample.data.length, at + 4);
    entries.writeUInt32BE(sample.flags >>> 0, at + 8);
    if (offsets) {
      entries.writeInt32BE(sample.compositionOffset ?? 0, at + 12);
    }
    mdat.push(sample.data);
    mdatSize += sample.data.length;
  }
  const tfdt = Buffer.alloc(12);
  tfdt.writeUInt32BE(0x01000000);
  tfdt.writeBigUInt64BE(BigInt(baseTime), 4);
  // The data offset is filled in once the moof size is known.
  const trun = Buffer.alloc(12);
  trun.writeUInt32BE(offsets ? 0x01000f01 : 0x000701);
  trun.writeUInt32BE(samples.length, 4);
  const moof = box(
    'moof',
    box('mfhd', uint32(0), uint32(1)),
    box(
      'traf',
      box('tfhd', uint32(0x020000), uint32(TRACK_ID)),
      box('tfdt', tfdt),
      box('trun', trun, entries),
    ),
  );
  moof.writeUInt32BE(moof.length + 8, moof.length - entries.length - 4);

  mdat[0]!.writeUInt32BE(mdatSize);
  mdat[0]!.write('mdat', 4, 'latin1');

  return Buffer.concat([moof, ...mdat]);
}

/** What an init segment states about its track besides the sample entry. */
export type InitTrack = {
  kind: 'video' | 'audio';
  timescale: number;
  language: string;
  width?: number | undefined;
  height?: number | undefined;
};

const UNITY_MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

/**
 * An init segment for one track, numbered like ffmpeg's output so the
 * fragments of writeFragment belong to it, with `entry` as its only sample
 * entry.
 */
export function initSegment(entry: Buffer, track: InitTrack): Buffer {
  const isVideo = track.kind === 'video';
  const matrix = Buffer.alloc(UNITY_MATRIX.length * 4);
  for (const [i, value] of UNITY_MATRIX.entries()) {
    matrix.writeUInt32BE(value, i * 4);
  }
  const zero = uint32(0);

  const mvhd = box(
    'mvhd',
    zero,
    zero,
    zero,
    uint32(1000),
    zero,
    uint32(0x10000),
    Buffer.from([1, 0]),
    Buffer.alloc(10),
    matrix,
    Buffer.alloc(24),
    uint32(TRACK_ID + 1),
  );
  // Enabled and in the movie.
  const tkhd = box(
    'tkhd',
    uint32(3),
    zero,
    zero,
    uint32(TRACK_ID),
    zero,
    zero,
    Buffer.alloc(12),
    Buffer.from([isVideo ? 0 : 1, 0]),
    Buffer.alloc(2),
    matrix,
    uint32((track.width ?? 0) * 0x10000),
    uint32((track.height ?? 0) * 0x10000),
  );
  const mdhd = box(
    'mdhd',
    zero,
    zero,
    zero,
    uint32(track.timescale),
    zero,
    packedLanguage(track.language),
    Buffer.alloc(2),
  );
  const hdlr = box(
    'hdlr',
    zero,
    zero,
    Buffer.from(isVideo ? 'vide' : 'soun', 'latin1'),
    Buffer.alloc(12),
    Buffer.alloc(1),
  );
  const mediaHeader = isVideo
    ? box('vmhd', uint32(1), Buffer.alloc(8))
    : box('smhd', zero, Buffer.alloc(4));
  const dinf = box('dinf', box('dref', zero, uint32(1), box('url ', uint32(1))));
  const stbl = box(
    'stbl',
    box('stsd', zero, uint32(1), entry),
    box('stts', zero, zero),
    box('stsc', zero, zero),
    box('stsz', zero, zero, zero),
    box('stco', zero, zero),
  );
  const mvex = box(
    'mvex',
    box('trex', zero, uint32(TRACK_ID), uint32(1), zero, zero, zero),
  );

  return Buffer.concat([
    box('ftyp', Buffer.from('iso6', 'latin1'), zero, Buffer.from('iso6mp41', 'latin1')),
    box(
      'moov',
      mvhd,
      box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mediaHeader, dinf, stbl))),
      mvex,
    ),
  ]);
}

// Three letters, five bits each, offset by 0x60.
function packedLanguage(language: string): Buffer {
  const code = /^[a-z]{3}$/u.test(language) ? language : 'und';
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(
    ((code.codePointAt(0)! - 0x60) << 10) |
      ((code.codePointAt(1)! - 0x60) << 5) |
      (code.codePointAt(2)! - 0x60),
  );

  return buf;
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const header = Buffer.alloc(8);
  let size = 8;
  for (const part of payload) {
    size += part.length;
  }
  header.writeUInt32BE(size);
  header.write(type, 4, 'latin1');

  return Buffer.concat([header, ...payload]);
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);

  return buf;
}
