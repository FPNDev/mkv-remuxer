import { Transform, type TransformCallback } from 'node:stream';

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

export function retimeFragment(moof: Buffer, pts: number[]): void {
  const trun = findBox(moof, ['moof', 'traf', 'trun']).start;
  const version = moof[trun];
  const flags = moof.readUIntBE(trun + 1, 3);
  // Without per-sample durations every frame has the same length, so ffmpeg
  // repaired no timestamps and the fragment is already right.
  if (!(flags & 0x800) || !(flags & 0x100)) {
    return;
  }
  const count = moof.readUInt32BE(trun + 4);
  if (count !== pts.length) {
    throw new Error(
      `Fragment has ${count} samples but ${pts.length} timestamps`,
    );
  }

  const sorted = pts.toSorted((a, b) => a - b);
  let shift = 0;
  for (const [i, value] of pts.entries()) {
    shift = Math.max(shift, sorted[i]! - value);
  }
  const dts = sorted.map((value) => value - shift);

  const tfdt = findBox(moof, ['moof', 'traf', 'tfdt']).start;
  if (moof[tfdt] === 1) {
    moof.writeBigUInt64BE(BigInt(dts[0]!), tfdt + 4);
  } else {
    moof.writeUInt32BE(dts[0]!, tfdt + 4);
  }

  let pos = trun + 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
  for (const [i, value] of pts.entries()) {
    const next = dts[i + 1];
    if (next !== undefined) {
      moof.writeUInt32BE(next - dts[i]!, pos);
    }
    pos += 4 + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0);
    if (version === 1) {
      moof.writeInt32BE(value - dts[i]!, pos);
    } else {
      moof.writeUInt32BE(value - dts[i]!, pos);
    }
    pos += 4;
  }
}
