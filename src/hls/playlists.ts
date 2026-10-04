import {
  aacChannels,
  codecString,
  type Rendition,
  type RenditionSet,
} from '../media/codecs.js';
import { hevcTransferCharacteristics } from '../media/hevc.js';
import {
  segmentCount,
  segmentEnd,
  segmentStart,
  type MediaIndex,
} from '../media/media-index.js';
import type { MkvTrack } from '../matroska/tracks.js';

const AUDIO_GROUP = 'audio';
const SUBTITLE_GROUP = 'subs';
const VIDEO_RANGES: Record<number, string> = { 16: 'PQ', 18: 'HLG' };

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

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

export function renditionPath(rendition: Rendition): string {
  switch (rendition.type) {
    case 'video':
      return 'video';
    case 'audio':
      return `audio/${rendition.track.number}`;
    case 'subtitle':
      return `subtitles/${rendition.track.number}`;
  }
}

export function segmentFileName(rendition: Rendition, n: number): string {
  return `${n}.${rendition.type === 'subtitle' ? 'vtt' : 'm4s'}`;
}

export function mediaPlaylist(index: MediaIndex, rendition: Rendition): string {
  const durations = Array.from(
    { length: segmentCount(index) },
    (_, n) => segmentEnd(index, n) - segmentStart(index, n),
  );

  // Version 7 is the floor for fragmented MP4 segments and EXT-X-MAP.
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    // Must be an integer and no shorter than the longest segment.
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  // Subtitle renditions are WebVTT and have no init segment.
  if (rendition.type !== 'subtitle') {
    lines.push('#EXT-X-MAP:URI="init.mp4"');
  }
  for (const [n, duration] of durations.entries()) {
    lines.push(
      `#EXTINF:${duration.toFixed(3)},`,
      segmentFileName(rendition, +n),
    );
  }
  lines.push('#EXT-X-ENDLIST');

  return `${lines.join('\n')}\n`;
}

export function masterPlaylist(
  index: MediaIndex,
  renditions: RenditionSet,
  basePath: string,
): string {
  const uri = (rendition: Rendition) =>
    `${basePath}/${renditionPath(rendition)}/index.m3u8`;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];

  const namesMap = new Map<string, number>();

  // At most one member of an audio group may be DEFAULT.
  const defaultAudio =
    renditions.audio.find((audio) => audio.track.isDefault) ??
    renditions.audio[0];

  for (const audio of renditions.audio) {
    const channels = audio.transcode
      ? aacChannels(audio.track)
      : (audio.track.channels ?? 2);
    lines.push(
      `#EXT-X-MEDIA:${attributes({
        TYPE: 'AUDIO',
        'GROUP-ID': quoted(AUDIO_GROUP),
        NAME: quoted(uniqueLabel(audio.track, namesMap)),
        LANGUAGE: optionalQuoted(bcp47(audio.track.language)),
        DEFAULT: audio === defaultAudio ? 'YES' : 'NO',
        AUTOSELECT: 'YES',
        CHANNELS: quoted(String(channels)),
        URI: quoted(uri(audio)),
      })}`,
    );
  }

  namesMap.clear();

  for (const subtitle of renditions.subtitles) {
    lines.push(
      `#EXT-X-MEDIA:${attributes({
        TYPE: 'SUBTITLES',
        'GROUP-ID': quoted(SUBTITLE_GROUP),
        NAME: quoted(uniqueLabel(subtitle.track, namesMap)),
        LANGUAGE: optionalQuoted(bcp47(subtitle.track.language)),
        DEFAULT: 'NO',
        AUTOSELECT: 'YES',
        FORCED: subtitle.track.isForced ? 'YES' : 'NO',
        URI: quoted(uri(subtitle)),
      })}`,
    );
  }

  const { track } = renditions.video;
  const codecs = [renditions.video, ...renditions.audio].map((rendition) =>
    codecString(rendition),
  );
  const averageBandwidth = Math.round((index.fileLength * 8) / index.duration);
  const variant = {
    BANDWIDTH: String(Math.round(averageBandwidth * 1.5)),
    'AVERAGE-BANDWIDTH': String(averageBandwidth),
    CODECS: codecs.every(Boolean)
      ? quoted([...new Set(codecs)].join(','))
      : undefined,
    AUDIO: renditions.audio.length > 0 ? quoted(AUDIO_GROUP) : undefined,
    SUBTITLES:
      renditions.subtitles.length > 0 ? quoted(SUBTITLE_GROUP) : undefined,
    'CLOSED-CAPTIONS': 'NONE',
    RESOLUTION:
      track.width && track.height
        ? `${track.width}x${track.height}`
        : undefined,
    'FRAME-RATE': track.defaultDurationNs
      ? (1e9 / track.defaultDurationNs).toFixed(3)
      : undefined,
  };
  // Firefox's MediaCapabilities rejects every av01 codec string paired with
  // a PQ or HLG transfer function, but runs no such check on HEVC strings.
  const videoRange =
    renditions.video.codec === 'hevc'
      ? VIDEO_RANGES[hevcTransferCharacteristics(track)]
      : undefined;

  lines.push(
    `#EXT-X-STREAM-INF:${attributes({
      ...variant,
      'VIDEO-RANGE': videoRange,
    })}`,
    uri(renditions.video),
  );
  if (videoRange) {
    lines.push(
      `#EXT-X-STREAM-INF:${attributes({
        ...variant,
        'VIDEO-RANGE': 'SDR',
      })}`,
      `${uri(renditions.video)}?range=sdr`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function attributes(values: Record<string, string | undefined>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      pairs.push(`${key}=${value}`);
    }
  }

  return pairs.join(',');
}

// A quoted attribute value may hold neither a double quote nor a line
// break.
function quoted(value: string): string {
  return `"${value.replaceAll(/["\r\n]/gu, "'")}"`;
}

function optionalQuoted(value: string | undefined): string | undefined {
  return value === undefined ? undefined : quoted(value);
}

function bcp47(language: string): string | undefined {
  if (!language || language === 'und') {
    return undefined;
  }
  return ISO_639_1[language.toLowerCase()] ?? language;
}

function uniqueLabel(track: MkvTrack, used: Map<string, number>): string {
  const language = bcp47(track.language);
  let label = track.name;
  if (!label && language) {
    try {
      label = languageNames.of(language);
    } catch {
      label = undefined;
    }
  }
  label ??= `Unknown`;

  const usedTimes = (used.get(label) ?? 0) + 1;
  if (usedTimes > 1) {
    label = `${label} #${usedTimes}`;
  }
  used.set(label, usedTimes);

  return label;
}
