import { mkdir } from 'node:fs/promises';

import type { ByteSource } from '../io/byte-source.js';
import { Mp4Error } from '../mp4/boxes.js';
import { readMp4Layout, type Mp4LayoutTrack } from '../mp4/layout.js';
import { sampleTableFile, writeSampleTable } from '../mp4/samples.js';
import { isRemuxableVideo } from './codecs.js';
import {
  FRAME_RATE_FRAMES,
  MEDIA_INDEX_VERSION,
  measuredFrameRate,
  planSegments,
  type IndexBase,
} from './media-index.js';
import type { MediaTrack } from './track.js';

/**
 * Where the segments fall in one track's sample table, which sits in its own
 * file. Times are in the track timescale.
 */
export type Mp4TrackSamples = {
  timescale: number;
  count: number;
  /** Per segment: its first sample and the time it starts at. */
  first: number[];
  starts: number[];
  /** Samples at sampleRate one audio packet decodes to. */
  frame?: number | undefined;
};

export type Mp4Index = IndexBase & {
  container: 'mp4';
  tracks: MediaTrack[];
  /** Start in seconds of each segment, on the video timeline. */
  segmentTimes: number[];
  /** Keyed by track number. */
  samples: Record<number, Mp4TrackSamples>;
};

type TrackSegments = Pick<Mp4TrackSamples, 'first' | 'starts'>;

/**
 * Indexes an MP4 or QuickTime file and writes each track's sample table
 * into tableDir.
 */
export async function buildMp4Index(
  source: ByteSource,
  fileName: string,
  targetDuration: number,
  tableDir: string,
): Promise<Mp4Index> {
  const layout = (await readMp4Layout(source)).filter(
    (track) => track.samples.offsets.length > 0,
  );
  const video =
    layout.find(
      ({ track }) => track.kind === 'video' && isRemuxableVideo(track.codecId),
    ) ?? layout.find(({ track }) => track.kind === 'video');
  if (!video) {
    throw new Mp4Error('File has no video track');
  }

  // Segment 0 starts at the first sample whatever it is; later ones on sync
  // samples.
  const keyframes = [0];
  const keyframeTimes = [presentation(video, 0) / video.timescale];
  for (const [i, sync] of video.samples.sync.entries()) {
    if (sync && i > 0) {
      keyframes.push(i);
      keyframeTimes.push(presentation(video, i) / video.timescale);
    }
  }

  let duration = 0;
  for (const track of layout) {
    if (track.track.kind === 'subtitle') {
      continue;
    }
    for (const i of track.samples.dts.keys()) {
      duration = Math.max(
        duration,
        (presentation(track, i) + track.samples.durations[i]!) /
          track.timescale,
      );
    }
  }

  const starts = planSegments(keyframeTimes, duration, targetDuration);
  const segmentTimes = starts.map((k, n) => (n === 0 ? 0 : keyframeTimes[k]!));

  await mkdir(tableDir, { recursive: true });
  const samples: Record<number, Mp4TrackSamples> = {};
  for (const track of layout) {
    const { number, kind, sampleRate } = track.track;
    const { durations } = track.samples;
    await writeSampleTable(sampleTableFile(tableDir, number), track.samples);
    samples[number] = {
      timescale: track.timescale,
      count: durations.length,
      ...(track === video
        ? videoSegments(track, starts, keyframes, segmentTimes)
        : otherSegments(track, segmentTimes)),
      frame:
        kind === 'audio'
          ? Math.round(
              (durations[durations.length >> 1]! * (sampleRate ?? track.timescale)) /
                track.timescale,
            )
          : undefined,
    };
  }

  const firstFrames: number[] = [];
  for (let i = 0; i < Math.min(FRAME_RATE_FRAMES, video.samples.dts.length); i++) {
    firstFrames.push(presentation(video, i));
  }

  return {
    container: 'mp4',
    version: MEDIA_INDEX_VERSION,
    fileName,
    fileLength: source.length,
    duration,
    videoTrack: video.track.number,
    targetDuration,
    frameRate: measuredFrameRate(firstFrames, 1e9 / video.timescale),
    tracks: layout.map(({ track }) => track),
    segmentTimes,
    samples,
  };
}

function presentation(track: Mp4LayoutTrack, i: number): number {
  return track.samples.dts[i]! + track.samples.ctos[i]!;
}

function videoSegments(
  track: Mp4LayoutTrack,
  starts: number[],
  keyframes: number[],
  segmentTimes: number[],
): TrackSegments {
  return {
    first: starts.map((k) => keyframes[k]!),
    starts: segmentTimes.map((seconds) =>
      Math.round(seconds * track.timescale),
    ),
  };
}

/**
 * Audio segments start on a sample boundary near the video segment's start,
 * so no packet is split or played twice; where the track has a gap there,
 * the segment starts at the video time or after the last sample before it.
 * A subtitle segment starts with the first sample still on screen.
 */
function otherSegments(
  track: Mp4LayoutTrack,
  segmentTimes: number[],
): TrackSegments {
  const { durations } = track.samples;
  const count = durations.length;
  const first: number[] = [];
  const starts: number[] = [];
  const end = (i: number) => presentation(track, i) + durations[i]!;
  let i = 0;
  for (const [n, seconds] of segmentTimes.entries()) {
    const at = Math.round(seconds * track.timescale);
    if (track.track.kind === 'subtitle') {
      while (i < count && end(i) <= at) {
        i++;
      }
      first.push(i);
      starts.push(at);
      continue;
    }
    if (n === 0) {
      // Packets before zero are cut, as the first segment starts there.
      while (i < count && presentation(track, i) < 0) {
        i++;
      }
      first.push(i);
      starts.push(0);
      continue;
    }

    while (i < count && presentation(track, i) + durations[i]! / 2 <= at) {
      i++;
    }
    const start =
      i < count && presentation(track, i) - at <= durations[i]!
        ? presentation(track, i)
        : Math.max(at, i > 0 ? end(i - 1) : at);
    first.push(i);
    starts.push(Math.max(start, starts.at(-1)!));
  }

  return { first, starts };
}
