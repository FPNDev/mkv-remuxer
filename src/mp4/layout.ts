import { readRange, type ByteSource } from '../io/byte-source.js';
import type { MediaTrack, TrackKind } from '../media/track.js';
import {
  children,
  findChild,
  findPath,
  Mp4Error,
  payload,
  readBoxHeader,
  type Mp4Box,
} from './boxes.js';
import { describeEntry } from './sample-entry.js';
import { emptyColumns, type SampleColumns } from './samples.js';

/** A track and every sample it has. */
export type Mp4LayoutTrack = {
  track: MediaTrack;
  timescale: number;
  samples: SampleColumns;
};

/** Track defaults from trex that a fragment's tfhd may override. */
type FragmentDefaults = {
  duration: number;
  size: number;
  flags: number;
};

type TrackState = Mp4LayoutTrack & {
  defaults: FragmentDefaults;
  /** Decode time the next fragment sample takes when its traf has no tfdt. */
  nextDts: number;
};

/** A top-level box of the file, in file offsets. */
type FileBox = {
  type: string;
  start: number;
  end: number;
};

type Moof = {
  start: number;
  data: Buffer;
};

/** A sidx box and the file offset its references count from. */
type SegmentIndex = {
  data: Buffer;
  end: number;
};

const HANDLER_KINDS: Record<string, TrackKind> = {
  vide: 'video',
  soun: 'audio',
  sbtl: 'subtitle',
  subt: 'subtitle',
  text: 'subtitle',
};
// Names muxers write into every handler box. They say nothing of the track.
const GENERIC_HANDLER_NAME =
  /handler|core media|gpac|mainconcept|l-smash|bento4|^apple/iu;
// The longest box header: size, type and a 64-bit size.
const BOX_HEADER_BYTES = 16;
// tfhd and trun flags, and the sample flag of a non-sync sample.
const BASE_DATA_OFFSET = 0x1;
const SAMPLE_DESCRIPTION = 0x2;
const DEFAULT_DURATION = 0x8;
const DEFAULT_SIZE = 0x10;
const DEFAULT_FLAGS = 0x20;
const DEFAULT_BASE_IS_MOOF = 0x20000;
const DATA_OFFSET = 0x1;
const FIRST_SAMPLE_FLAGS = 0x4;
const SAMPLE_DURATION = 0x100;
const SAMPLE_SIZE = 0x200;
const SAMPLE_FLAGS = 0x400;
const SAMPLE_CTO = 0x800;
const NON_SYNC = 0x10000;

/**
 * Reads the tracks and sample tables of an MP4 or QuickTime file: from the
 * moov box, and for a fragmented file from every moof too. The moofs are
 * found through sidx boxes when the file has them, else by walking the file.
 */
export async function readMp4Layout(
  source: ByteSource,
): Promise<Mp4LayoutTrack[]> {
  let moov: Buffer | undefined;
  let firstMoof: number | undefined;
  const indexes: SegmentIndex[] = [];
  let pos = 0;
  while (pos + 8 <= source.length) {
    const box = await fileBox(source, pos);
    if (box.type === 'moov') {
      moov = await readRange(source, box.start, box.end);
      if (!findChild(moov, readBoxHeader(moov, 0)!, 'mvex')) {
        break;
      }
    } else if (box.type === 'sidx') {
      indexes.push({
        data: await readRange(source, box.start, box.end),
        end: box.end,
      });
    } else if (box.type === 'moof') {
      firstMoof = box.start;
      break;
    }
    pos = box.end;
  }
  if (!moov) {
    throw new Mp4Error('File has no moov box');
  }

  const root = readBoxHeader(moov, 0)!;
  const mvhd = findChild(moov, root, 'mvhd');
  if (!mvhd) {
    throw new Mp4Error('File has no mvhd box');
  }
  const header = payload(moov, mvhd);
  const movieTimescale = header.readUInt32BE(header[0] === 1 ? 20 : 12);

  const defaults = trackDefaults(moov, root);
  const states = new Map<number, TrackState>();
  const shifts = new Map<number, number>();
  for (const trak of children(moov, root)) {
    if (trak.type !== 'trak') {
      continue;
    }
    const parsed = readTrak(moov, trak);
    if (!parsed) {
      continue;
    }
    const { samples } = parsed;
    const last = samples.dts.length - 1;
    states.set(parsed.track.number, {
      ...parsed,
      defaults: defaults.get(parsed.track.number) ?? {
        duration: 0,
        size: 0,
        flags: 0,
      },
      nextDts: last >= 0 ? samples.dts[last]! + samples.durations[last]! : 0,
    });
    shifts.set(
      parsed.track.number,
      editShift(moov, trak, movieTimescale, parsed.timescale),
    );
  }

  if (firstMoof !== undefined) {
    const moofs =
      (indexes.length > 0 ? await indexedMoofs(source, indexes) : undefined) ??
      (await moofsIn(source, firstMoof, source.length));
    moofs.sort((a, b) => a.start - b.start);
    for (const moof of moofs) {
      readMoof(moof, states);
    }
  }

  const tracks: Mp4LayoutTrack[] = [];
  const defaultKinds = new Set<TrackKind>();
  for (const [id, { track, timescale, samples }] of states) {
    const shift = shifts.get(id)!;
    for (const i of samples.dts.keys()) {
      samples.dts[i] += shift;
    }
    // The first enabled track of a kind plays unless the viewer picks another.
    track.isDefault = track.isEnabled && !defaultKinds.has(track.kind);
    if (track.isDefault) {
      defaultKinds.add(track.kind);
    }
    tracks.push({ track, timescale, samples });
  }

  return tracks;
}

async function fileBox(source: ByteSource, pos: number): Promise<FileBox> {
  const header = await readRange(
    source,
    pos,
    Math.min(source.length, pos + BOX_HEADER_BYTES),
  );
  const box = readBoxHeader(header, 0, Math.min(header.length, source.length - pos));
  if (!box) {
    throw new Mp4Error(`Box header at ${pos} is cut short`);
  }
  // A size of zero runs the box to the end of the file.
  const size = header.readUInt32BE(0) === 0 ? source.length - pos : box.end;

  return { type: box.type, start: pos, end: pos + size };
}

function trackDefaults(
  moov: Buffer,
  root: Mp4Box,
): Map<number, FragmentDefaults> {
  const found = new Map<number, FragmentDefaults>();
  const mvex = findChild(moov, root, 'mvex');
  if (!mvex) {
    return found;
  }
  for (const box of children(moov, mvex)) {
    if (box.type === 'trex') {
      const body = payload(moov, box);
      found.set(body.readUInt32BE(4), {
        duration: body.readUInt32BE(12),
        size: body.readUInt32BE(16),
        flags: body.readUInt32BE(20),
      });
    }
  }

  return found;
}

function readTrak(moov: Buffer, trak: Mp4Box): Mp4LayoutTrack | undefined {
  const tkhd = findChild(moov, trak, 'tkhd');
  const mdia = findChild(moov, trak, 'mdia');
  const mdhd = mdia && findChild(moov, mdia, 'mdhd');
  const hdlr = mdia && findChild(moov, mdia, 'hdlr');
  const stbl = mdia && findPath(moov, mdia, ['minf', 'stbl']);
  const stsd = stbl && findChild(moov, stbl, 'stsd');
  if (!tkhd || !mdhd || !hdlr || !stsd) {
    return undefined;
  }

  const handler = payload(moov, hdlr);
  const kind = HANDLER_KINDS[handler.toString('latin1', 8, 12)];
  // A track with several sample entries switches decoder config midway,
  // which one init segment can't describe.
  if (!kind || payload(moov, stsd).readUInt32BE(4) !== 1) {
    return undefined;
  }
  const entryBox = readBoxHeader(moov, stsd.body + 8, stsd.end);
  if (!entryBox) {
    return undefined;
  }
  const entry = moov.subarray(entryBox.start, entryBox.end);

  const media = payload(moov, mdhd);
  const longMedia = media[0] === 1;
  const timescale = media.readUInt32BE(longMedia ? 20 : 12);
  const info = describeEntry(entry, kind, timescale);
  if (!info) {
    return undefined;
  }

  const trackHeader = payload(moov, tkhd);
  const iso639Language = packedLanguage(
    media.readUInt16BE(longMedia ? 32 : 20),
  );
  const elng = findChild(moov, mdia, 'elng');
  const udtaName = findPath(moov, trak, ['udta', 'name']);

  return {
    track: {
      ...info,
      number: trackHeader.readUInt32BE(trackHeader[0] === 1 ? 20 : 12),
      kind,
      name:
        (udtaName && cString(payload(moov, udtaName))) ??
        handlerName(handler.subarray(24)),
      language: (elng && cString(payload(moov, elng).subarray(4))) ?? iso639Language,
      iso639Language,
      isDefault: false,
      isForced: false,
      isEnabled: (trackHeader.readUIntBE(1, 3) & 1) === 1,
      entry: entry.toString('base64'),
    },
    timescale,
    samples: stblSamples(moov, stbl),
  };
}

// Three five-bit letters offset by 0x60. Lower values are Macintosh language
// codes, which carry no ISO 639-2 code.
function packedLanguage(code: number): string {
  if (code < 0x400 || code === 0x7fff) {
    return 'und';
  }

  return String.fromCodePoint(
    ((code >> 10) & 31) + 0x60,
    ((code >> 5) & 31) + 0x60,
    (code & 31) + 0x60,
  );
}

function cString(bytes: Buffer): string | undefined {
  const end = bytes.indexOf(0);
  const text = bytes
    .toString('utf8', 0, end === -1 ? bytes.length : end)
    .trim();

  return text || undefined;
}

// QuickTime writes the handler name as a Pascal string, ISO as a C string.
function handlerName(bytes: Buffer): string | undefined {
  const pascal = bytes.length > 1 && bytes[0] === bytes.length - 1;
  const name = cString(pascal ? bytes.subarray(1) : bytes);

  return name && !GENERIC_HANDLER_NAME.test(name) ? name : undefined;
}

// Where the track's media time zero lands on the movie timeline, in track
// units: an empty edit delays it, the first media edit skips into it.
function editShift(
  moov: Buffer,
  trak: Mp4Box,
  movieTimescale: number,
  timescale: number,
): number {
  const elst = findPath(moov, trak, ['edts', 'elst']);
  if (!elst) {
    return 0;
  }
  const body = payload(moov, elst);
  const long = body[0] === 1;
  const entrySize = long ? 20 : 12;
  let delay = 0;
  for (
    let at = 8, i = 0;
    i < body.readUInt32BE(4) && at + entrySize <= body.length;
    at += entrySize, i++
  ) {
    const duration = long
      ? Number(body.readBigUInt64BE(at))
      : body.readUInt32BE(at);
    const mediaTime = long
      ? Number(body.readBigInt64BE(at + 8))
      : body.readInt32BE(at + 4);
    if (mediaTime !== -1) {
      return Math.round((delay * timescale) / movieTimescale) - mediaTime;
    }
    delay += duration;
  }

  return Math.round((delay * timescale) / movieTimescale);
}

function stblSamples(moov: Buffer, stbl: Mp4Box): SampleColumns {
  const columns = emptyColumns();
  const sizes = sampleSizes(moov, stbl);
  const chunks = chunkOffsets(moov, stbl);

  const stsc = findChild(moov, stbl, 'stsc');
  if (stsc) {
    const body = payload(moov, stsc);
    const entries = body.readUInt32BE(4);
    let sample = 0;
    for (let e = 0; e < entries && sample < sizes.length; e++) {
      const at = 8 + e * 12;
      const perChunk = body.readUInt32BE(at + 4);
      const nextFirst =
        e + 1 < entries ? body.readUInt32BE(at + 12) - 1 : chunks.length;
      for (
        let c = body.readUInt32BE(at) - 1;
        c < Math.min(nextFirst, chunks.length) && sample < sizes.length;
        c++
      ) {
        let offset = chunks[c]!;
        for (let s = 0; s < perChunk && sample < sizes.length; s++) {
          columns.offsets.push(offset);
          columns.sizes.push(sizes[sample]!);
          offset += sizes[sample]!;
          sample++;
        }
      }
    }
  }
  const count = columns.offsets.length;

  const stts = findChild(moov, stbl, 'stts');
  let dts = 0;
  let delta = 0;
  if (stts) {
    const body = payload(moov, stts);
    for (let e = 0; e < body.readUInt32BE(4); e++) {
      const runLength = body.readUInt32BE(8 + e * 8);
      delta = body.readUInt32BE(12 + e * 8);
      for (let s = 0; s < runLength && columns.dts.length < count; s++) {
        columns.dts.push(dts);
        columns.durations.push(delta);
        dts += delta;
      }
    }
  }
  // A short table leaves the last delta for the samples it misses.
  while (columns.dts.length < count) {
    columns.dts.push(dts);
    columns.durations.push(delta);
    dts += delta;
  }

  // Version 0 offsets are unsigned by the spec, yet muxers write negative
  // ones there too, so both versions read signed.
  const ctts = findChild(moov, stbl, 'ctts');
  if (ctts) {
    const body = payload(moov, ctts);
    for (let e = 0; e < body.readUInt32BE(4); e++) {
      const runLength = body.readUInt32BE(8 + e * 8);
      const offset = body.readInt32BE(12 + e * 8);
      for (let s = 0; s < runLength && columns.ctos.length < count; s++) {
        columns.ctos.push(offset);
      }
    }
  }
  while (columns.ctos.length < count) {
    columns.ctos.push(0);
  }

  // Without an stss box every sample is a sync sample.
  const stss = findChild(moov, stbl, 'stss');
  columns.sync = Array.from({ length: count }, () => !stss);
  if (stss) {
    const body = payload(moov, stss);
    for (let e = 0; e < body.readUInt32BE(4); e++) {
      const sample = body.readUInt32BE(8 + e * 4) - 1;
      if (sample < count) {
        columns.sync[sample] = true;
      }
    }
  }

  return columns;
}

function sampleSizes(moov: Buffer, stbl: Mp4Box): number[] {
  const sizes: number[] = [];
  const stsz = findChild(moov, stbl, 'stsz');
  if (stsz) {
    const body = payload(moov, stsz);
    const fixed = body.readUInt32BE(4);
    const count = body.readUInt32BE(8);
    for (let i = 0; i < count; i++) {
      sizes.push(fixed || body.readUInt32BE(12 + i * 4));
    }

    return sizes;
  }

  const stz2 = findChild(moov, stbl, 'stz2');
  if (stz2) {
    const body = payload(moov, stz2);
    const fieldSize = body[7]!;
    const count = body.readUInt32BE(8);
    for (let i = 0; i < count; i++) {
      if (fieldSize === 4) {
        const byte = body[12 + (i >> 1)]!;
        sizes.push(i & 1 ? byte & 15 : byte >> 4);
      } else {
        sizes.push(body.readUIntBE(12 + i * (fieldSize / 8), fieldSize / 8));
      }
    }
  }

  return sizes;
}

function chunkOffsets(moov: Buffer, stbl: Mp4Box): number[] {
  const offsets: number[] = [];
  const stco = findChild(moov, stbl, 'stco');
  const co64 = stco ? undefined : findChild(moov, stbl, 'co64');
  const box = stco ?? co64;
  if (!box) {
    return offsets;
  }
  const body = payload(moov, box);
  for (let i = 0; i < body.readUInt32BE(4); i++) {
    offsets.push(
      co64
        ? Number(body.readBigUInt64BE(8 + i * 8))
        : body.readUInt32BE(8 + i * 4),
    );
  }

  return offsets;
}

// Undefined when a reference points at another sidx, which leaves the moofs
// to a walk of the file.
async function indexedMoofs(
  source: ByteSource,
  indexes: SegmentIndex[],
): Promise<Moof[] | undefined> {
  const ranges = new Map<number, number>();
  for (const { data, end } of indexes) {
    const body = payload(data, readBoxHeader(data, 0)!);
    const long = body[0] !== 0;
    let at = 12;
    let start =
      end +
      (long ? Number(body.readBigUInt64BE(at + 8)) : body.readUInt32BE(at + 4));
    at += long ? 18 : 10;
    const count = body.readUInt16BE(at);
    at += 2;
    for (let i = 0; i < count; i++, at += 12) {
      const reference = body.readUInt32BE(at);
      if (reference & 0x80000000) {
        return undefined;
      }
      const size = reference & 0x7fffffff;
      ranges.set(start, start + size);
      start += size;
    }
  }

  const found = await Promise.all(
    Array.from(ranges, ([start, end]) => moofsIn(source, start, end)),
  );

  return found.flat();
}

// Walks the boxes of [start, end) one after another, reading only moofs.
async function moofsIn(
  source: ByteSource,
  start: number,
  end: number,
): Promise<Moof[]> {
  const moofs: Moof[] = [];
  let pos = start;
  while (pos + 8 <= Math.min(end, source.length)) {
    const box = await fileBox(source, pos);
    if (box.type === 'moof') {
      moofs.push({
        start: box.start,
        data: await readRange(source, box.start, box.end),
      });
    }
    pos = box.end;
  }

  return moofs;
}

function readMoof(moof: Moof, states: Map<number, TrackState>): void {
  const { data, start } = moof;
  const root = readBoxHeader(data, 0)!;
  // A traf with no base offset of its own continues after the data of the
  // one before; the first starts at the moof.
  let dataEnd = start;
  for (const traf of children(data, root)) {
    const tfhd = traf.type === 'traf' && findChild(data, traf, 'tfhd');
    if (!tfhd) {
      continue;
    }
    const header = payload(data, tfhd);
    const flags = header.readUIntBE(1, 3);
    const state = states.get(header.readUInt32BE(4));
    if (!state) {
      continue;
    }
    let at = 8;
    let base = flags & DEFAULT_BASE_IS_MOOF ? start : dataEnd;
    if (flags & BASE_DATA_OFFSET) {
      base = Number(header.readBigUInt64BE(at));
      at += 8;
    }
    if (flags & SAMPLE_DESCRIPTION) {
      at += 4;
    }
    let { duration, size, flags: sampleFlags } = state.defaults;
    if (flags & DEFAULT_DURATION) {
      duration = header.readUInt32BE(at);
      at += 4;
    }
    if (flags & DEFAULT_SIZE) {
      size = header.readUInt32BE(at);
      at += 4;
    }
    if (flags & DEFAULT_FLAGS) {
      sampleFlags = header.readUInt32BE(at);
    }

    const tfdt = findChild(data, traf, 'tfdt');
    if (tfdt) {
      const time = payload(data, tfdt);
      state.nextDts =
        time[0] === 1 ? Number(time.readBigUInt64BE(4)) : time.readUInt32BE(4);
    }

    const { samples } = state;
    let offset = base;
    for (const trun of children(data, traf)) {
      if (trun.type !== 'trun') {
        continue;
      }
      const run = payload(data, trun);
      const runFlags = run.readUIntBE(1, 3);
      const count = run.readUInt32BE(4);
      let p = 8;
      if (runFlags & DATA_OFFSET) {
        offset = base + run.readInt32BE(p);
        p += 4;
      }
      let firstFlags = sampleFlags;
      if (runFlags & FIRST_SAMPLE_FLAGS) {
        firstFlags = run.readUInt32BE(p);
        p += 4;
      }
      for (let i = 0; i < count; i++) {
        let sampleDuration = duration;
        let sampleSize = size;
        let thisFlags = i === 0 ? firstFlags : sampleFlags;
        let cto = 0;
        if (runFlags & SAMPLE_DURATION) {
          sampleDuration = run.readUInt32BE(p);
          p += 4;
        }
        if (runFlags & SAMPLE_SIZE) {
          sampleSize = run.readUInt32BE(p);
          p += 4;
        }
        if (runFlags & SAMPLE_FLAGS) {
          thisFlags = run.readUInt32BE(p);
          p += 4;
        }
        if (runFlags & SAMPLE_CTO) {
          cto = run.readInt32BE(p);
          p += 4;
        }
        samples.offsets.push(offset);
        samples.dts.push(state.nextDts);
        samples.durations.push(sampleDuration);
        samples.sizes.push(sampleSize);
        samples.ctos.push(cto);
        samples.sync.push((thisFlags & NON_SYNC) === 0);
        offset += sampleSize;
        state.nextDts += sampleDuration;
      }
    }
    dataEnd = offset;
  }
}
