import { UnsupportedMediaError } from '../errors.js';
import { childElements, readElementHeader, readUint } from '../matroska/ebml.js';
import type { MkvTrack } from '../matroska/tracks.js';
import type { AudioGrid, MediaIndex } from './media-index.js';

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

// Copied into fMP4 untouched, and playable in Chrome and Firefox. A_AAC is a
// prefix match because its profile suffixes vary; the rest must match exactly.
const PLAYABLE_AUDIO = /^(A_AAC|A_OPUS$|A_FLAC$)/u;
// Copied too, though those browsers can't decode them. Any other audio is
// never copied and is served only as a language's AAC rendition.
const COPIED_AUDIO =
  /^(A_MPEG\/L3|A_AC3|A_EAC3|A_DTS|A_DTS\/EXPRESS|A_DTS\/LOSSLESS|A_TRUEHD)$/u;
// Source preference for a language's AAC rendition after channel count,
// best first. Codecs matching none rank last.
const QUALITY_TIERS = [
  /^A_TRUEHD$/u,
  /^A_PCM\//u,
  /^(A_MLP|A_ALAC|A_WAVPACK4|A_TTA1)$/u,
  /^A_DTS/u,
  /^A_EAC3$/u,
  /^A_AC3$/u,
  /^A_MPEG\/L3$/u,
];
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

// Rates the AAC encoder accepts, ascending. Anything else takes the nearest.
const AAC_SAMPLE_RATES = [
  7350, 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000,
  88200, 96000,
];
// The AAC encoder takes up to eight channels in its own layouts.
const MAX_AAC_CHANNELS = 8;

/**
 * A layout above eight channels folded into a bed the AAC encoder accepts.
 * mix is the ffmpeg pan definition of each output channel.
 */
type AacFold = {
  layout: string;
  channels: number;
  mix: string;
};

// Keyed by channel count: ffmpeg gives such tracks its default layout for
// the count (5.1.4, 7.1.4, 9.1.4, 9.1.6, 22.2). Every channel outside the bed
// joins the nearest ear-level speaker, or both of a pair, at -3 dB.
const AAC_FOLDS: Record<number, AacFold> = {
  10: {
    layout: '5.1',
    channels: 6,
    mix: 'FL=FL+0.707*TFL|FR=FR+0.707*TFR|FC=FC|LFE=LFE|BL=SL+0.707*TBL|BR=SR+0.707*TBR',
  },
  12: {
    layout: '7.1',
    channels: 8,
    mix: 'FL=FL+0.707*TFL|FR=FR+0.707*TFR|FC=FC|LFE=LFE|BL=BL+0.707*TBL|BR=BR+0.707*TBR|SL=SL|SR=SR',
  },
  14: {
    layout: '7.1',
    channels: 8,
    mix: 'FL=FL+0.707*FLC+0.707*TFL|FR=FR+0.707*FRC+0.707*TFR|FC=FC|LFE=LFE|BL=BL+0.707*TBL|BR=BR+0.707*TBR|SL=SL|SR=SR',
  },
  16: {
    layout: '7.1',
    channels: 8,
    mix: 'FL=FL+0.707*FLC+0.707*TFL|FR=FR+0.707*FRC+0.707*TFR|FC=FC|LFE=LFE|BL=BL+0.707*TBL|BR=BR+0.707*TBR|SL=SL+0.707*TSL|SR=SR+0.707*TSR',
  },
  // By channel index: pan can't name LFE2. FL, FR, FC, LFE, BL, BR, FLC, FRC,
  // BC, SL, SR, TC, TFL, TFC, TFR, TBL, TBC, TBR, LFE2, TSL, TSR, BFC, BFL,
  // BFR in, FL, FR, FC, LFE, BL, BR, SL, SR out.
  24: {
    layout: '7.1',
    channels: 8,
    mix: 'c0=c0+0.707*c6+0.707*c12+0.707*c22|c1=c1+0.707*c7+0.707*c14+0.707*c23|c2=c2+0.707*c13+0.707*c21|c3=c3+0.707*c18|c4=c4+0.707*c8+0.707*c15+0.707*c16|c5=c5+0.707*c8+0.707*c17+0.707*c16|c6=c9+0.707*c19+0.707*c11|c7=c10+0.707*c20+0.707*c11',
  },
};

// RFC 6381 strings for the audio that is copied rather than transcoded.
const OTHER_AUDIO_CODECS: Record<string, string> = {
  A_OPUS: 'Opus',
  A_FLAC: 'fLaC',
  A_AC3: 'ac-3',
  A_EAC3: 'ec-3',
  A_DTS: 'mp4a.a9',
  'A_DTS/EXPRESS': 'mp4a.a9',
  'A_DTS/LOSSLESS': 'mp4a.a9',
  A_TRUEHD: 'mlpa',
};

// HLS wants BCP 47 language tags. Matroska carries ISO 639-2, which has
// both a bibliographic and a terminological code for some languages.
const ISO_639_1: Record<string, string> = {
  ara: 'ar',
  bul: 'bg',
  cat: 'ca',
  ces: 'cs',
  cze: 'cs',
  chi: 'zh',
  zho: 'zh',
  dan: 'da',
  deu: 'de',
  ger: 'de',
  ell: 'el',
  gre: 'el',
  eng: 'en',
  spa: 'es',
  est: 'et',
  fas: 'fa',
  per: 'fa',
  fin: 'fi',
  fra: 'fr',
  fre: 'fr',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kat: 'ka',
  geo: 'ka',
  kaz: 'kk',
  kor: 'ko',
  lit: 'lt',
  lav: 'lv',
  msa: 'ms',
  may: 'ms',
  nld: 'nl',
  dut: 'nl',
  nor: 'no',
  nob: 'nb',
  pol: 'pl',
  por: 'pt',
  ron: 'ro',
  rum: 'ro',
  rus: 'ru',
  slk: 'sk',
  slo: 'sk',
  slv: 'sl',
  srp: 'sr',
  swe: 'sv',
  tha: 'th',
  tur: 'tr',
  ukr: 'uk',
  vie: 'vi',
};

/**
 * Picks the tracks that can be served. Throws UnsupportedMediaError when the
 * video track has no fMP4 mapping, which leaves the file unplayable here.
 * With aacFallback, the best track of each language that browsers can't play
 * also gets an AAC rendition, unless a playable track there has as many
 * channels.
 */
export function getRenditions(
  index: MediaIndex,
  aacFallback: boolean,
): RenditionSet {
  const video = index.tracks.find((track) => track.number === index.videoTrack);
  const codec = video && VIDEO_CODECS[video.codecId];
  if (!video || !codec) {
    throw new UnsupportedMediaError(
      `Video codec ${video?.codecId ?? 'unknown'} can't be remuxed to HLS`,
    );
  }

  let audio: AudioRendition[];
  let subtitles: SubtitleRendition[];

  [audio, subtitles] = filterRenditions(index, aacFallback);
  if (audio.length === 0 || subtitles.length === 0) {
    [audio, subtitles] = filterRenditions(index, aacFallback, {
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
  aacFallback: boolean,
  { audioByLanguage = true, subsByLanguage = true } = {},
): [AudioRendition[], SubtitleRendition[]] {
  const audio: AudioRendition[] = [];
  const subtitles: SubtitleRendition[] = [];
  const kept: MkvTrack[] = [];
  // Per language: the most channels a playable track has, and the best track
  // that browsers can't play.
  const playableChannels = new Map<string, number>();
  const aacSources = new Map<string, MkvTrack>();

  for (const track of index.tracks) {
    if (
      track.kind === 'audio' &&
      !UNSUPPORTED_AUDIO.test(track.codecId) &&
      !(audioByLanguage && UNSUPPORTED_LANGUAGES.has(track.language))
    ) {
      kept.push(track);
      const language = languageKey(track);
      if (PLAYABLE_AUDIO.test(track.codecId)) {
        playableChannels.set(
          language,
          Math.max(playableChannels.get(language) ?? 0, channelCount(track)),
        );
      } else if (aacFallback && canTranscode(track)) {
        const best = aacSources.get(language);
        if (!best || outranks(track, best)) {
          aacSources.set(language, track);
        }
      }
    } else if (
      track.kind === 'subtitle' &&
      TEXT_SUBTITLES.has(track.codecId) &&
      !(subsByLanguage && UNSUPPORTED_LANGUAGES.has(track.language))
    ) {
      subtitles.push({ type: 'subtitle', track });
    }
  }

  // Each AAC rendition follows the track it is transcoded from.
  for (const track of kept) {
    if (
      PLAYABLE_AUDIO.test(track.codecId) ||
      COPIED_AUDIO.test(track.codecId)
    ) {
      audio.push({ type: 'audio', track, transcode: false });
    }
    const language = languageKey(track);
    if (
      aacSources.get(language) === track &&
      (playableChannels.get(language) ?? 0) < channelCount(track)
    ) {
      audio.push({ type: 'audio', track, transcode: true });
    }
  }

  return [audio, subtitles];
}

function languageKey(track: MkvTrack): string {
  return bcp47(track.language) ?? 'und';
}

function channelCount(track: MkvTrack): number {
  return track.channels ?? 2;
}

// Above eight channels only a layout with a fold can become AAC.
function canTranscode(track: MkvTrack): boolean {
  const channels = channelCount(track);

  return channels <= MAX_AAC_CHANNELS || AAC_FOLDS[channels] !== undefined;
}

function qualityTier(codecId: string): number {
  const tier = QUALITY_TIERS.findIndex((pattern) => pattern.test(codecId));

  return tier === -1 ? QUALITY_TIERS.length : tier;
}

function outranks(track: MkvTrack, other: MkvTrack): boolean {
  const differences = [
    channelCount(track) - channelCount(other),
    qualityTier(other.codecId) - qualityTier(track.codecId),
    (track.sampleRate ?? 0) - (other.sampleRate ?? 0),
    Number(track.isDefault) - Number(other.isDefault),
  ];
  for (const difference of differences) {
    if (difference !== 0) {
      return difference > 0;
    }
  }

  return false;
}

/** Whether Chrome and Firefox can play the rendition. */
export function isPlayable(rendition: AudioRendition): boolean {
  return rendition.transcode || PLAYABLE_AUDIO.test(rendition.track.codecId);
}

export function bcp47(language: string): string | undefined {
  if (!language || language === 'und') {
    return undefined;
  }

  return ISO_639_1[language.toLowerCase()] ?? language;
}

// A tie goes to the higher rate.
export function aacSampleRate(track: MkvTrack): number {
  const rate = track.sampleRate ?? 48000;
  let nearest = AAC_SAMPLE_RATES[0]!;
  for (const accepted of AAC_SAMPLE_RATES) {
    if (Math.abs(accepted - rate) <= Math.abs(nearest - rate)) {
      nearest = accepted;
    }
  }

  return nearest;
}

export function aacFold(track: MkvTrack): AacFold | undefined {
  return AAC_FOLDS[Math.round(track.channels ?? 2)];
}

export function aacChannels(track: MkvTrack): number {
  const channels = Math.max(1, Math.round(track.channels ?? 2));

  return AAC_FOLDS[channels]?.channels ?? channels;
}

/** Whether the track is served as a copy of its source audio. */
export function isCopiedAudio(track: MkvTrack): boolean {
  return (
    track.kind === 'audio' &&
    (PLAYABLE_AUDIO.test(track.codecId) || COPIED_AUDIO.test(track.codecId))
  );
}

// Packets from one encode land within this of the frame grid: the Matroska
// tick rounding plus a sample.
const GRID_TOLERANCE_SECONDS = 0.002;
// The most TrueHD access units between two major syncs.
const TRUEHD_RESTART_INTERVAL = 128;
const MATROSKA_CODEC_DELAY = 0x56aa;

const AAC_CONFIG_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];
const AAC_CONFIG_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];
const DTS_RATES: Record<number, number> = {
  1: 8000,
  2: 16000,
  3: 32000,
  6: 11025,
  7: 22050,
  8: 44100,
  11: 12000,
  12: 24000,
  13: 48000,
};
const AC3_BITRATES = [
  32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512,
  576, 640,
];
// Layer III kbps by bitrate index: MPEG-2 and 2.5, then MPEG-1.
const MP3_BITRATES = [
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
];
// Opus frame sizes at 48 kHz, longest first.
const OPUS_FRAMES = [2880, 1920, 960, 480, 240, 120];
const FLAC_BLOCK_SIZES = [
  0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384,
  32768,
];

/**
 * AudioSpecificConfig fields. With SBR or PS the rate and channel count are
 * those of the AAC core.
 */
type AacConfig = {
  rate: number;
  frame: number;
  channels: number;
};

function aacConfig(track: MkvTrack): AacConfig {
  const asc = Buffer.from(track.codecPrivate ?? '', 'base64');
  if (asc.length < 2) {
    return {
      rate: track.sampleRate ?? 48000,
      frame: 1024,
      channels: track.channels ?? 2,
    };
  }
  const objectType = asc[0]! >> 3;
  const rateIndex = ((asc[0]! & 7) << 1) | (asc[1]! >> 7);
  const channelConfig = (asc[1]! >> 3) & 15;
  const frameLengthFlag = (asc[1]! >> 2) & 1;

  return {
    rate: AAC_CONFIG_RATES[rateIndex] ?? track.sampleRate ?? 48000,
    frame: objectType === 2 && frameLengthFlag ? 960 : 1024,
    // Parametric stereo carries a mono core.
    channels:
      objectType === 29
        ? 1
        : AAC_CONFIG_CHANNELS[channelConfig] || (track.channels ?? 2),
  };
}

function codecDelaySeconds(track: MkvTrack): number {
  const entry = Buffer.from(track.entry, 'base64');
  const header = readElementHeader(entry, 0);
  if (!header) {
    return 0;
  }
  for (const el of childElements(entry, header.headerLength)) {
    if (el.id === MATROSKA_CODEC_DELAY) {
      return readUint(entry, el) / 1e9;
    }
  }

  return 0;
}

/**
 * The frame grid of a copied track. first is its first block: the start time
 * in seconds and the first frame. Without it the grid starts at zero and the
 * codec's usual frame size is taken.
 */
export function copyGrid(
  track: MkvTrack,
  first: { seconds: number; frame: Buffer } | undefined,
): AudioGrid {
  const id = track.codecId;
  let rate = track.sampleRate ?? 48000;
  let frame: number;
  if (id.startsWith('A_AAC')) {
    ({ rate, frame } = aacConfig(track));
  } else if (id === 'A_MPEG/L3') {
    frame = rate <= 24000 ? 576 : 1152;
  } else if (id === 'A_OPUS') {
    rate = 48000;
    frame = first ? opusSamples(first.frame) : 960;
  } else if (id === 'A_FLAC') {
    const streamInfo = Buffer.from(track.codecPrivate ?? '', 'base64');
    frame = streamInfo.length >= 10 ? streamInfo.readUInt16BE(8) : 4096;
  } else if (id === 'A_TRUEHD') {
    frame = rate % 48000 === 0 ? rate / 1200 : rate / 1102.5;
  } else if (id.startsWith('A_DTS')) {
    // The core frame header: block count, then the core rate.
    const header = first?.frame;
    if (header && header.length >= 9 && header.readUInt32BE(0) === 0x7ffe8001) {
      rate = DTS_RATES[(header[8]! >> 2) & 15] ?? rate;
      frame = ((((header[4]! & 1) << 6) | (header[5]! >> 2)) + 1) * 32;
    } else {
      frame = track.defaultDurationNs
        ? Math.round((track.defaultDurationNs * rate) / 1e9)
        : 512;
    }
  } else {
    frame = 1536;
  }

  const restart = id === 'A_TRUEHD' ? TRUEHD_RESTART_INTERVAL * frame : 0;

  return {
    rate,
    frame,
    lead:
      Math.ceil(frame / 2 + GRID_TOLERANCE_SECONDS * rate) + restart,
    origin: first ? first.seconds - codecDelaySeconds(track) : 0,
  };
}

// Samples at 48 kHz in an Opus packet, from its TOC byte.
function opusSamples(packet: Buffer): number {
  const config = packet[0]! >> 3;
  const size =
    config < 12
      ? [480, 960, 1920, 2880][config & 3]!
      : config < 16
        ? [480, 960][config & 1]!
        : [120, 240, 480, 960][config & 3]!;
  const code = packet[0]! & 3;

  return size * (code === 0 ? 1 : code < 3 ? 2 : packet[1]! & 0x3f);
}

/** Samples at the grid rate that one packet of a copied track decodes to. */
export function packetSamples(
  track: MkvTrack,
  packet: Buffer,
  grid: AudioGrid,
): number {
  if (track.codecId === 'A_OPUS' && packet.length > 1) {
    return opusSamples(packet);
  }
  if (track.codecId !== 'A_FLAC' || packet.length < 6) {
    return grid.frame;
  }
  const code = packet[2]! >> 4;
  if (code !== 6 && code !== 7) {
    return FLAC_BLOCK_SIZES[code] || grid.frame;
  }
  // The size follows the UTF-8 coded frame or sample number.
  let ones = 0;
  for (let mask = 0x80; packet[4]! & mask; mask >>= 1) {
    ones++;
  }
  const at = 4 + Math.max(1, ones);

  return code === 6 ? packet[at]! + 1 : packet.readUInt16BE(at) + 1;
}

/**
 * Sizes in samples of the silent frames that fill `samples` of a copied
 * track. When no set of whole frames adds up, the last one is longer than
 * what is left and is cut short in the fragment.
 */
export function silenceSizes(
  track: MkvTrack,
  grid: AudioGrid,
  samples: number,
): number[] {
  const sizes = track.codecId === 'A_OPUS' ? OPUS_FRAMES : [grid.frame];
  const result: number[] = [];
  let rest = samples;
  for (const size of sizes) {
    while (rest >= size) {
      result.push(size);
      rest -= size;
    }
  }
  if (rest > 0) {
    // FLAC frames take any length.
    result.push(track.codecId === 'A_FLAC' ? rest : sizes.at(-1)!);
  }

  return result;
}

/**
 * ffmpeg arguments, input and encoder, that make silent frames of `samples`
 * length for a copied track, closest match first. packet is a real packet of
 * the track. Later entries use layouts that every encoder takes.
 */
export function silenceEncoders(
  track: MkvTrack,
  packet: Buffer,
  grid: AudioGrid,
  samples: number,
): string[][] {
  const id = track.codecId;
  let channels = track.channels ?? 2;
  let encoder: string[];
  if (id.startsWith('A_AAC')) {
    channels = aacConfig(track).channels;
    encoder = ['-c:a', 'aac'];
  } else if (id === 'A_MPEG/L3') {
    const mpeg1 = ((packet[1]! >> 3) & 3) === 3;
    const bitrate = MP3_BITRATES[mpeg1 ? 1 : 0]![packet[2]! >> 4] || 64;
    channels = packet[3]! >> 6 === 3 ? 1 : 2;
    encoder = ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`];
  } else if (id === 'A_OPUS') {
    const head = Buffer.from(track.codecPrivate ?? '', 'base64');
    const family = channels > 2 || (head[18] ?? 1) > 1 ? 1 : head[18]!;
    encoder = [
      '-c:a',
      'libopus',
      '-mapping_family',
      String(family),
      '-frame_duration',
      String(samples / 48),
    ];
  } else if (id === 'A_FLAC') {
    const streamInfo = Buffer.from(track.codecPrivate ?? '', 'base64');
    const bits =
      streamInfo.length >= 22
        ? (((streamInfo[20]! & 1) << 4) | (streamInfo[21]! >> 4)) + 1
        : 16;
    encoder = [
      '-c:a',
      'flac',
      '-frame_size',
      String(samples),
      '-sample_fmt',
      bits > 16 ? 's32' : 's16',
      '-bits_per_raw_sample',
      String(bits),
    ];
  } else if (id === 'A_AC3') {
    const bitrate = AC3_BITRATES[(packet[4]! & 0x3f) >> 1] ?? 448;
    encoder = ['-c:a', 'ac3', '-b:a', `${bitrate}k`];
  } else if (id === 'A_EAC3') {
    const bytes = ((((packet[2]! & 7) << 8) | packet[3]!) + 1) * 2;
    const blocks = [1, 2, 3, 6][(packet[4]! >> 4) & 3]!;
    const bitrate = Math.round(
      (bytes * 8 * grid.rate) / (blocks * 256) / 1000,
    );
    encoder = ['-c:a', 'eac3', '-b:a', `${bitrate}k`];
  } else if (id === 'A_TRUEHD') {
    encoder = ['-c:a', 'truehd', '-strict', '-2'];
  } else {
    encoder = ['-c:a', 'dca', '-strict', '-2'];
  }

  const layouts = [`${channels}c`];
  if (channels > 6) {
    layouts.push('5.1(side)');
  }
  if (channels > 2) {
    layouts.push('stereo');
  }
  const inputs: string[][] = [];
  for (const layout of layouts) {
    inputs.push(
      [
        '-f',
        'lavfi',
        '-i',
        `anullsrc=r=${grid.rate}:cl=${layout}`,
        '-map',
        '0:0',
      ].concat(encoder),
    );
  }

  return inputs;
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
    // ffmpeg marks MP3 below 32 kHz as MPEG-2 audio, object type 0x69.
    if (track.codecId === 'A_MPEG/L3') {
      return (track.sampleRate ?? 48000) > 24000 ? 'mp4a.6B' : 'mp4a.69';
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
