import type {
  AudioRendition,
  SubtitleRendition,
  VideoRendition,
} from '../media/codecs.js';
import { segmentCount, segmentStart } from '../media/media-index.js';
import type { Mp4Index, Mp4TrackSamples } from '../media/mp4-index.js';
import { isoAudioEntry } from '../mp4/sample-entry.js';
import {
  readSampleData,
  readSampleTable,
  sampleTableFile,
  type SampleRecord,
} from '../mp4/samples.js';
import { textCues } from '../mp4/text.js';
import {
  initSegment,
  TIMELINE_OFFSET_SECONDS,
  writeFragment,
  type FragmentSample,
} from './mp4.js';
import type { RemuxTarget } from './remux.js';

export type Mp4Target = RemuxTarget<Mp4Index>;

/** Sample records, and the bytes of those inside the range asked for. */
type LoadedSamples = {
  records: SampleRecord[];
  data: Buffer[];
};

// sample_depends_on: no other sample, or some other sample and not a sync one.
export const SYNC_FLAGS = 0x02000000;
const NON_SYNC_FLAGS = 0x01010000;

// ffmpeg reads the stream as the moov describes it, so -copyts keeps the
// fragment times, and the offset they were written with comes off again.
export const MP4_INPUT_ARGS = [
  '-copyts',
  '-itsoffset',
  String(-TIMELINE_OFFSET_SECONDS),
  '-f',
  'mp4',
  '-i',
  'pipe:0',
  '-map',
  '0:0',
];

/** The init segment of a copied track, around the source's own sample entry. */
export function mp4Init(
  index: Mp4Index,
  rendition: VideoRendition | AudioRendition,
): Buffer {
  const { track } = rendition;
  let entry: Buffer = Buffer.from(track.entry, 'base64');
  if (rendition.type === 'audio') {
    entry = isoAudioEntry(entry);
  } else if (entry.toString('latin1', 4, 8) === 'hev1') {
    // HEVC in fMP4 must carry the hvc1 tag; players reject hev1 here.
    entry.write('hvc1', 4, 'latin1');
  }

  return initSegment(entry, {
    kind: rendition.type,
    timescale: index.samples[track.number]!.timescale,
    language: track.iso639Language,
    width: track.width,
    height: track.height,
  });
}

/** The first sample of segment n and the first past it. */
export function segmentSamples(
  index: Mp4Index,
  samples: Mp4TrackSamples,
  n: number,
): [number, number] {
  return [
    samples.first[n]!,
    n + 1 < segmentCount(index) ? samples.first[n + 1]! : samples.count,
  ];
}

/**
 * Samples from..to and their bytes. extra more records are read past `to`,
 * without their bytes, for the times they start at.
 */
export async function loadSamples(
  target: Mp4Target,
  from: number,
  to: number,
  extra = 0,
): Promise<LoadedSamples> {
  const records = await readSampleTable(
    sampleTableFile(target.sampleDir, target.rendition.track.number),
    from,
    to + extra,
  );
  const data = await readSampleData(
    target.source,
    records.slice(0, Math.max(0, to - Math.max(0, from))),
  );

  return { records, data };
}

/**
 * Segment n of the video track: its samples as they are, each lasting until
 * the next one is decoded, so segments join without a hole.
 */
export async function mp4VideoSegment(
  target: Mp4Target,
  rendition: VideoRendition,
  n: number,
): Promise<Buffer> {
  const { index } = target;
  const samples = index.samples[rendition.track.number]!;
  const [from, to] = segmentSamples(index, samples, n);
  const { records, data } = await loadSamples(target, from, to, 1);
  const out: FragmentSample[] = [];
  for (const [i, sample] of data.entries()) {
    const record = records[i]!;
    const next = records[i + 1];
    out.push({
      dts: record.dts,
      duration: next ? Math.max(0, next.dts - record.dts) : record.duration,
      flags: record.sync ? SYNC_FLAGS : NON_SYNC_FLAGS,
      data: sample,
      compositionOffset: record.cto,
    });
  }

  // The first frame is shown from the start of the playlist.
  if (n === 0 && out.length > 0) {
    let first = 0;
    for (const i of out.keys()) {
      if (shownAt(records[i]!) < shownAt(records[first]!)) {
        first = i;
      }
    }
    if (shownAt(records[first]!) > 0) {
      out[first]!.compositionOffset = -records[first]!.dts;
    }
  }

  return writeFragment(
    records[0]!.dts + TIMELINE_OFFSET_SECONDS * samples.timescale,
    out,
  );
}

/**
 * Segment n of a text track as WebVTT, cue times on the shared timeline. A
 * cue on screen across a segment boundary is in both segments.
 */
export async function mp4SubtitleSegment(
  target: Mp4Target,
  rendition: SubtitleRendition,
  n: number,
): Promise<Buffer> {
  const { index } = target;
  const { track } = rendition;
  const samples = index.samples[track.number]!;
  const [from, to] = segmentSamples(index, samples, n);
  // The sample on screen at the next segment's start is the first one past.
  const { records, data } = await loadSamples(target, from, to + 1);
  const entry = Buffer.from(track.entry, 'base64');
  const start = segmentStart(index, n);
  const end =
    n + 1 < segmentCount(index)
      ? segmentStart(index, n + 1)
      : Number.POSITIVE_INFINITY;

  let body = 'WEBVTT\n\n';
  for (const [i, record] of records.entries()) {
    const shown = shownAt(record) / samples.timescale;
    const hidden = shown + record.duration / samples.timescale;
    if (shown >= end || hidden <= start) {
      continue;
    }
    for (const cue of textCues(entry, data[i]!)) {
      const settings = cue.settings ? ` ${cue.settings}` : '';
      body += `${vttTime(shown)} --> ${vttTime(hidden)}${settings}\n${cue.text}\n\n`;
    }
  }

  return Buffer.from(body);
}

/**
 * An init segment around the source's sample entry, unchanged, and one
 * fragment of samples from..to, for ffmpeg to decode. Only the init segment
 * when the range holds no samples.
 */
export async function mp4DecodeInput(
  target: Mp4Target,
  from: number,
  to: number,
): Promise<Buffer[]> {
  const { index, rendition } = target;
  const { track } = rendition;
  const { timescale } = index.samples[track.number]!;
  const init = initSegment(Buffer.from(track.entry, 'base64'), {
    kind: 'audio',
    timescale,
    language: track.iso639Language,
  });
  const { records, data } = await loadSamples(target, from, to);
  if (records.length === 0) {
    return [init];
  }
  const out: FragmentSample[] = [];
  for (const [i, record] of records.entries()) {
    const next = records[i + 1];
    out.push({
      dts: record.dts,
      duration: next ? Math.max(0, next.dts - record.dts) : record.duration,
      flags: SYNC_FLAGS,
      data: data[i]!,
      compositionOffset: record.cto,
    });
  }

  return [
    init,
    writeFragment(records[0]!.dts + TIMELINE_OFFSET_SECONDS * timescale, out),
  ];
}

function shownAt(record: SampleRecord): number {
  return record.dts + record.cto;
}

function vttTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');

  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}
