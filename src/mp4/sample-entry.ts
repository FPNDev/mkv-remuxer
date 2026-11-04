import type { MediaTrack, TrackKind } from '../media/track.js';
import { childBoxes, children, payload, type Mp4Box } from './boxes.js';

/** What a sample entry tells about its track. */
export type EntryInfo = Pick<
  MediaTrack,
  | 'codecId'
  | 'codecPrivate'
  | 'width'
  | 'height'
  | 'sampleRate'
  | 'channels'
  | 'transferCharacteristics'
>;

type AudioFields = {
  version: number;
  channels: number;
  rate: number;
  children: number;
};

// MP4 sample entries map onto the Matroska codec ids the rest of the library
// already knows.
const VIDEO_IDS: Record<string, string> = {
  avc1: 'V_MPEG4/ISO/AVC',
  avc3: 'V_MPEG4/ISO/AVC',
  hvc1: 'V_MPEGH/ISO/HEVC',
  hev1: 'V_MPEGH/ISO/HEVC',
  av01: 'V_AV1',
  vp09: 'V_VP9',
};
// Their payload is what Matroska keeps as CodecPrivate.
const VIDEO_CONFIGS = new Set(['avcC', 'hvcC', 'av1C']);

const AUDIO_IDS: Record<string, string> = {
  'ac-3': 'A_AC3',
  'ec-3': 'A_EAC3',
  Opus: 'A_OPUS',
  fLaC: 'A_FLAC',
  dtsc: 'A_DTS',
  dtsh: 'A_DTS',
  dtsl: 'A_DTS/LOSSLESS',
  dtse: 'A_DTS/EXPRESS',
  mlpa: 'A_TRUEHD',
  alac: 'A_ALAC',
  '.mp3': 'A_MPEG/L3',
  'ms\0U': 'A_MPEG/L3',
  sowt: 'A_PCM/INT/LIT',
  twos: 'A_PCM/INT/BIG',
  'raw ': 'A_PCM/INT/LIT',
  lpcm: 'A_PCM/INT/LIT',
  ipcm: 'A_PCM/INT/LIT',
  in24: 'A_PCM/INT/BIG',
  in32: 'A_PCM/INT/BIG',
  fpcm: 'A_PCM/FLOAT/IEEE',
  fl32: 'A_PCM/FLOAT/IEEE',
  fl64: 'A_PCM/FLOAT/IEEE',
};
// The objectTypeIndication of an mp4a entry's decoder config.
const OBJECT_TYPES: Record<number, string> = {
  0x40: 'A_AAC',
  0x66: 'A_AAC',
  0x67: 'A_AAC',
  0x68: 'A_AAC',
  0x69: 'A_MPEG/L3',
  0x6b: 'A_MPEG/L3',
  0xa5: 'A_AC3',
  0xa6: 'A_EAC3',
  0xa9: 'A_DTS',
};

const SUBTITLE_IDS: Record<string, string> = {
  tx3g: 'S_TEXT/TX3G',
  wvtt: 'S_TEXT/WEBVTT',
};

// Boxes that configure the decoder, carried into a rebuilt audio entry.
const AUDIO_CONFIGS = new Set([
  'esds',
  'dac3',
  'dec3',
  'dOps',
  'dfLa',
  'ddts',
  'dmlp',
  'alac',
  'btrt',
]);

const AAC_CONFIG_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];
const ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];
// Channels each chan_loc bit of an E-AC-3 dependent substream adds, LFE2 first.
const CHAN_LOC_CHANNELS = [1, 1, 2, 2, 2, 1, 1, 2, 2];

// The child boxes of a visual sample entry follow 78 bytes of its own fields.
const VISUAL_CHILDREN = 8 + 78;

/** Undefined for an entry no rendition can use, such as an encrypted one. */
export function describeEntry(
  entry: Buffer,
  kind: TrackKind,
  timescale: number,
): EntryInfo | undefined {
  const fourcc = entry.toString('latin1', 4, 8);
  switch (kind) {
    case 'video':
      return describeVideo(entry, fourcc);
    case 'audio':
      return describeAudio(entry, fourcc, timescale);
    case 'subtitle': {
      const codecId = SUBTITLE_IDS[fourcc];

      return codecId ? { codecId } : undefined;
    }
  }
}

function describeVideo(entry: Buffer, fourcc: string): EntryInfo | undefined {
  if (fourcc === 'encv' || entry.length < VISUAL_CHILDREN) {
    return undefined;
  }
  const info: EntryInfo = {
    codecId: VIDEO_IDS[fourcc] ?? `V_MP4/${fourcc}`,
    width: entry.readUInt16BE(32),
    height: entry.readUInt16BE(34),
  };
  for (const box of childBoxes(entry, VISUAL_CHILDREN, entry.length)) {
    const body = payload(entry, box);
    if (VIDEO_CONFIGS.has(box.type)) {
      info.codecPrivate = body.toString('base64');
    }
    const colour = body.toString('latin1', 0, 4);
    if (
      box.type === 'colr' &&
      (colour === 'nclx' || colour === 'nclc') &&
      body.length >= 8
    ) {
      info.transferCharacteristics = body.readUInt16BE(6);
    }
  }

  return info;
}

function describeAudio(
  entry: Buffer,
  fourcc: string,
  timescale: number,
): EntryInfo | undefined {
  if (fourcc === 'enca' || entry.length < 36) {
    return undefined;
  }
  const fields = audioFields(entry);
  const boxes = audioConfigBoxes(entry, fields.children);
  const body = (type: string) => {
    const box = boxes.get(type);

    return box && payload(entry, box);
  };
  const info: EntryInfo = {
    codecId: AUDIO_IDS[fourcc] ?? `A_MP4/${fourcc}`,
    channels: fields.channels,
    sampleRate: fields.rate || timescale,
  };

  const esds = body('esds');
  if (fourcc === 'mp4a' && esds) {
    const config = decoderConfig(esds);
    info.codecId =
      OBJECT_TYPES[config?.objectType ?? 0] ??
      `A_MP4/mp4a.${config?.objectType ?? 0}`;
    const asc = config?.specific;
    if (info.codecId === 'A_AAC' && asc && asc.length >= 2) {
      info.codecPrivate = asc.toString('base64');
      info.channels =
        AAC_CONFIG_CHANNELS[(asc[1]! >> 3) & 15] || info.channels;
    }
  }

  const dac3 = body('dac3');
  if (dac3 && dac3.length >= 2) {
    info.channels = ACMOD_CHANNELS[(dac3[1]! >> 3) & 7]! + ((dac3[1]! >> 2) & 1);
  }

  const dec3 = body('dec3');
  if (dec3 && dec3.length >= 5) {
    let channels = ACMOD_CHANNELS[(dec3[3]! >> 1) & 7]! + (dec3[3]! & 1);
    if ((dec3[4]! >> 1) & 15 && dec3.length >= 6) {
      const chanLoc = ((dec3[4]! & 1) << 8) | dec3[5]!;
      for (const [bit, added] of CHAN_LOC_CHANNELS.entries()) {
        if (chanLoc & (1 << bit)) {
          channels += added;
        }
      }
    }
    info.channels = channels;
  }

  const dOps = body('dOps');
  if (dOps && dOps.length >= 11) {
    info.codecPrivate = opusHead(dOps).toString('base64');
    info.channels = dOps[1]!;
    info.sampleRate = 48000;
  }

  const dfLa = body('dfLa');
  // A full box: version and flags, then the FLAC metadata blocks.
  if (dfLa && dfLa.length >= 4 + 4 + 18) {
    const blocks = dfLa.subarray(4);
    info.codecPrivate = Buffer.concat([Buffer.from('fLaC'), blocks]).toString(
      'base64',
    );
    const streamInfo = blocks.subarray(4);
    info.channels = ((streamInfo[12]! >> 1) & 7) + 1;
    info.sampleRate =
      (streamInfo[10]! << 12) | (streamInfo[11]! << 4) | (streamInfo[12]! >> 4);
  }

  return info;
}

/**
 * The entry in the ISO version 0 layout browsers read. QuickTime version 1
 * and 2 entries are rebuilt from their fields and decoder boxes; any other
 * entry is returned as it is.
 */
export function isoAudioEntry(entry: Buffer): Buffer {
  const fields = audioFields(entry);
  if (fields.version === 0) {
    return entry;
  }
  const head = Buffer.alloc(36);
  entry.copy(head, 0, 0, 16);
  head.writeUInt16BE(Math.min(0xffff, fields.channels), 24);
  head.writeUInt16BE(16, 26);
  // Rates past 16 bits do not fit; decoders read them from their config box.
  head.writeUInt32BE(fields.rate < 0x10000 ? Math.round(fields.rate) * 0x10000 : 0, 32);
  const configs: Buffer[] = [];
  for (const [type, box] of audioConfigBoxes(entry, fields.children)) {
    if (AUDIO_CONFIGS.has(type)) {
      configs.push(entry.subarray(box.start, box.end));
    }
  }
  const out = Buffer.concat([head, ...configs]);
  out.writeUInt32BE(out.length);

  return out;
}

// Version 1 adds four fields to version 0; version 2 replaces the rate and
// channel count with wider ones.
function audioFields(entry: Buffer): AudioFields {
  const version = entry.readUInt16BE(16);
  if (version === 2 && entry.length >= 72) {
    return {
      version,
      channels: entry.readUInt32BE(48),
      rate: entry.readDoubleBE(40),
      children: 72,
    };
  }

  return {
    version,
    channels: entry.readUInt16BE(24),
    rate: entry.readUInt16BE(32),
    children: version === 1 ? 52 : 36,
  };
}

// QuickTime nests the decoder boxes inside a wave box.
function audioConfigBoxes(entry: Buffer, start: number): Map<string, Mp4Box> {
  const found = new Map<string, Mp4Box>();
  for (const box of childBoxes(entry, start, entry.length)) {
    const nested = box.type === 'wave' ? children(entry, box) : [box];
    for (const inner of nested) {
      if (!found.has(inner.type)) {
        found.set(inner.type, inner);
      }
    }
  }

  return found;
}

/** objectTypeIndication and DecoderSpecificInfo from an esds payload. */
function decoderConfig(
  esds: Buffer,
): { objectType: number; specific?: Buffer | undefined } | undefined {
  // Past the version and flags.
  let pos = 4;
  const descriptor = () => {
    const tag = esds[pos++];
    let length = 0;
    for (let i = 0; i < 4 && pos < esds.length; i++) {
      const byte = esds[pos++]!;
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) {
        break;
      }
    }

    return { tag, end: Math.min(esds.length, pos + length) };
  };

  if (descriptor().tag !== 3) {
    return undefined;
  }
  const flags = esds[pos + 2] ?? 0;
  pos += 3;
  if (flags & 0x80) {
    pos += 2;
  }
  if (flags & 0x40) {
    pos += 1 + (esds[pos] ?? 0);
  }
  if (flags & 0x20) {
    pos += 2;
  }
  const config = descriptor();
  if (config.tag !== 4 || pos >= esds.length) {
    return undefined;
  }
  const objectType = esds[pos]!;
  // Past the stream type, buffer size and the two bitrates.
  pos += 13;
  if (pos >= config.end) {
    return { objectType };
  }
  const specific = descriptor();

  return {
    objectType,
    specific: specific.tag === 5 ? esds.subarray(pos, specific.end) : undefined,
  };
}

// The Matroska CodecPrivate of Opus: an OpusHead, little-endian, where the
// MP4 dOps box is big-endian and has no magic.
function opusHead(dOps: Buffer): Buffer {
  const head = Buffer.alloc(19 + dOps.length - 11);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = dOps[1]!;
  head.writeUInt16LE(dOps.readUInt16BE(2), 10);
  head.writeUInt32LE(dOps.readUInt32BE(4), 12);
  head.writeInt16LE(dOps.readInt16BE(8), 16);
  head[18] = dOps[10]!;
  dOps.copy(head, 19, 11);

  return head;
}
