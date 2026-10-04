import { UnsupportedMediaError } from '../errors.js';
import type { MkvTrack } from '../matroska/tracks.js';
import type { MediaIndex } from './media-index.js';

export type VideoCodec = 'avc' | 'hevc' | 'av1' | 'vp9';

export type VideoRendition = {
  type: 'video';
  track: MkvTrack;
  codec: VideoCodec;
};

export type AudioRendition = {
  type: 'audio';
  track: MkvTrack;
  transcode: boolean;
};

export type SubtitleRendition = {
  type: 'subtitle';
  track: MkvTrack;
};

export type Rendition = VideoRendition | AudioRendition | SubtitleRendition;

export type RenditionSet = {
  video: VideoRendition;
  audio: AudioRendition[];
  subtitles: SubtitleRendition[];
};

const VIDEO_CODECS: Record<string, VideoCodec> = {
  'V_MPEG4/ISO/AVC': 'avc',
  'V_MPEGH/ISO/HEVC': 'hevc',
  V_AV1: 'av1',
  V_VP9: 'vp9',
};

// Copied into fMP4 untouched. A_AAC is a prefix match because its profile
// suffixes vary; the rest must match exactly. Other audio is transcoded.
const COPYABLE_AUDIO = /^(A_AAC|A_MPEG\/L3$|A_OPUS$|A_FLAC$)/u;
// No usable decode path, so these tracks get no rendition at all.
const UNSUPPORTED_AUDIO = /^(A_REAL\/|A_QUICKTIME)/u;
const UNSUPPORTED_LANGUAGES = new Set(['ru', 'rus']);
// Only text subtitles convert to WebVTT. Bitmap formats such as PGS and
// VobSub would have to be rendered, so they are skipped.
const TEXT_SUBTITLES = new Set([
  'S_TEXT/UTF8',
  'S_TEXT/ASCII',
  'S_TEXT/ASS',
  'S_TEXT/SSA',
  'S_TEXT/WEBVTT',
  'S_ASS',
  'S_SSA',
]);

// Rates the AAC encoder accepts. Anything else is resampled to 48 kHz.
const AAC_SAMPLE_RATES = new Set([
  48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
]);
const MAX_AAC_CHANNELS = 6;

// RFC 6381 strings for the audio that is copied rather than transcoded.
const OTHER_AUDIO_CODECS: Record<string, string> = {
  'A_MPEG/L3': 'mp4a.40.34',
  A_OPUS: 'opus',
  A_FLAC: 'fLaC',
};

/**
 * Picks the tracks that can be served. Throws UnsupportedMediaError when the
 * video track has no fMP4 mapping, which leaves the file unplayable here.
 */
export function getRenditions(index: MediaIndex): RenditionSet {
  const video = index.tracks.find((track) => track.number === index.videoTrack);
  const codec = video && VIDEO_CODECS[video.codecId];
  if (!video || !codec) {
    throw new UnsupportedMediaError(
      `Video codec ${video?.codecId ?? 'unknown'} can't be remuxed to HLS`,
    );
  }

  let audio: AudioRendition[];
  let subtitles: SubtitleRendition[];

  [audio, subtitles] = filterRenditions(index);
  if (audio.length === 0 || subtitles.length === 0) {
    [audio, subtitles] = filterRenditions(index, {
      audioByLanguage: audio.length > 0,
      subsByLanguage: subtitles.length > 0,
    });
  }

  return {
    video: { type: 'video', track: video, codec },
    audio,
    subtitles,
  };
}

function filterRenditions(
  index: MediaIndex,
  { audioByLanguage = true, subsByLanguage = true } = {},
): [AudioRendition[], SubtitleRendition[]] {
  const audio: AudioRendition[] = [];
  const subtitles: SubtitleRendition[] = [];

  for (const track of index.tracks) {
    if (
      track.kind === 'audio' &&
      !UNSUPPORTED_AUDIO.test(track.codecId) &&
      !(audioByLanguage && UNSUPPORTED_LANGUAGES.has(track.language))
    ) {
      audio.push({
        type: 'audio',
        track,
        transcode: !COPYABLE_AUDIO.test(track.codecId),
      });
    } else if (
      track.kind === 'subtitle' &&
      TEXT_SUBTITLES.has(track.codecId) &&
      !(subsByLanguage && UNSUPPORTED_LANGUAGES.has(track.language))
    ) {
      subtitles.push({ type: 'subtitle', track });
    }
  }

  return [audio, subtitles];
}

export function aacSampleRate(track: MkvTrack): number {
  const rate = Math.round(track.sampleRate ?? 48000);
  return AAC_SAMPLE_RATES.has(rate) ? rate : 48000;
}

export function aacChannels(track: MkvTrack): number {
  return Math.min(
    MAX_AAC_CHANNELS,
    Math.max(1, Math.round(track.channels ?? 2)),
  );
}

/**
 * RFC 6381 codec string for a playlist. Undefined when CodecPrivate is missing
 * or the codec has no stable string, and the attribute is then left out.
 */
export function codecString(rendition: Rendition): string | undefined {
  if (rendition.type === 'subtitle') {
    return 'wvtt';
  }

  const { track } = rendition;
  const priv = track.codecPrivate
    ? Buffer.from(track.codecPrivate, 'base64')
    : undefined;

  if (rendition.type === 'audio') {
    if (rendition.transcode) {
      return 'mp4a.40.2';
    }
    if (track.codecId.startsWith('A_AAC')) {
      return `mp4a.40.${aacObjectType(track.codecId, priv)}`;
    }
    return OTHER_AUDIO_CODECS[track.codecId];
  }

  if (!priv) {
    return undefined;
  }
  switch (rendition.codec) {
    case 'avc':
      return avcCodecString(priv);
    case 'hevc':
      return hevcCodecString(priv);
    case 'av1':
      return av1CodecString(priv);
    case 'vp9':
      return undefined;
  }
}

const hex = (byte: number, width = 2) =>
  byte.toString(16).toUpperCase().padStart(width, '0');

// AudioSpecificConfig: five bits of object type, where 31 escapes to a further
// six bits offset by 32.
function aacObjectType(codecId: string, asc: Buffer | undefined): number {
  if (asc && asc.length >= 2) {
    const type = asc[0]! >> 3;
    return type === 31 ? 32 + (((asc[0]! & 0x07) << 3) | (asc[1]! >> 5)) : type;
  }
  return codecId.includes('SBR') ? 5 : 2;
}

// avcC: configuration version 1, then profile, constraint flags and level.
function avcCodecString(avcC: Buffer): string | undefined {
  if (avcC.length < 4 || avcC[0] !== 1) {
    return undefined;
  }
  return `avc1.${hex(avcC[1]!)}${hex(avcC[2]!)}${hex(avcC[3]!)}`;
}

function hevcCodecString(hvcC: Buffer): string | undefined {
  if (hvcC.length < 13) {
    return undefined;
  }

  const flags = hvcC[1]!;
  const space = ['', 'A', 'B', 'C'][flags >> 6] ?? '';
  const tier = (flags >> 5) & 1 ? 'H' : 'L';
  const profile = flags & 0x1f;

  // hvc1 strings carry the profile compatibility flags in reverse bit order.
  let compat = hvcC.readUInt32BE(2);
  let reversed = 0;
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | (compat & 1);
    compat >>>= 1;
  }

  // Trailing zero constraint bytes are dropped, as the codec string demands.
  const constraints = [...hvcC.subarray(6, 12)];
  while (constraints.at(-1) === 0) {
    constraints.pop();
  }

  return [
    `hvc1.${space}${profile}`,
    (reversed >>> 0).toString(16).toUpperCase(),
    `${tier}${hvcC[12]}`,
    ...constraints.map((byte) => byte.toString(16).toUpperCase()),
  ].join('.');
}

// av1C starts with a marker bit, then profile, level, tier and bit depth.
function av1CodecString(av1C: Buffer): string | undefined {
  if (av1C.length < 4 || (av1C[0]! & 0x80) === 0) {
    return undefined;
  }

  const profile = av1C[1]! >> 5;
  const level = av1C[1]! & 0x1f;
  const tier = av1C[2]! & 0x80 ? 'H' : 'M';
  const bitDepth = av1C[2]! & 0x40 ? (av1C[2]! & 0x20 ? 12 : 10) : 8;

  return `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(bitDepth).padStart(2, '0')}`;
}
