import type { ByteSource } from '../io/byte-source.js';
import { MatroskaError } from '../matroska/ebml.js';
import { readMatroskaLayout } from '../matroska/layout.js';
import type { SliceRange } from '../matroska/slicer.js';
import type { MkvTrack } from '../matroska/tracks.js';

// Bump when the index shape changes. A cached index of another version is
// rebuilt from the file rather than read.
export const MEDIA_INDEX_VERSION = 5;

/**
 * ts is a Matroska tick, cluster an absolute file offset, rel the block's
 * offset inside that cluster when the cue carried one.
 */
export type Keyframe = {
  ts: number;
  cluster: number;
  rel?: number | undefined;
};

/**
 * Everything needed to plan and cut segments without reading the file again.
 * Durations are seconds; keyframe and track timestamps stay in ticks.
 */
export type MediaIndex = {
  version: number;
  fileName: string;
  fileLength: number;
  docType: string;
  timestampScale: number;
  duration: number;
  firstClusterOffset: number;
  mediaEnd: number;
  ebmlHeader: string;
  info: string;
  tracks: MkvTrack[];
  videoTrack: number;
  keyframes: Keyframe[];
  segmentStarts: number[];
  targetDuration: number;
};

/**
 * A byte range to read plus the cut to apply to it. verifyStart asks the
 * remuxer to confirm the first block really lands where it was asked for.
 */
export type SliceTarget = {
  readStart: number;
  readEnd: number;
  range: SliceRange;
  verifyStart?: boolean;
};

// Never end on a sliver of a segment: fold a short tail into the one before.
const MIN_TAIL_SECONDS = 1;
// A track's blocks for a given time can sit clusters away from the video, so
// reads widen by this much. Tight slack is for files known to interleave well.
const INTERLEAVE_SLACK_SECONDS = 2;
const TIGHT_SLACK_SECONDS = 0.1;
// Widest element header plus the block peek: enough to identify the first
// block of the closing cluster and stop there.
const BOUNDARY_PEEK_BYTES = 12 + 64;

export async function buildMediaIndex(
  source: ByteSource,
  fileName: string,
  targetDuration: number,
): Promise<MediaIndex> {
  const layout = await readMatroskaLayout(source);

  const video = layout.tracks.find((track) => track.kind === 'video');
  if (!video) {
    throw new MatroskaError('File has no video track');
  }

  const keyframes: Keyframe[] = [];
  const cues = layout.cues
    .filter((cue) => cue.track === video.number)
    .sort((a, b) => a.time - b.time);

  for (const cue of cues) {
    if (keyframes.at(-1)?.ts === cue.time) {
      continue;
    }
    keyframes.push({
      ts: cue.time,
      cluster: cue.clusterPosition,
      rel: cue.relativePosition,
    });
  }

  if (keyframes.length === 0) {
    throw new MatroskaError('Cues index has no entries for the video track');
  }

  const toSeconds = (ticks: number) => (ticks * layout.timestampScale) / 1e9;
  const lastKeyframe = toSeconds(keyframes.at(-1)!.ts);
  let duration =
    layout.durationTicks === undefined ? 0 : toSeconds(layout.durationTicks);
  // Duration is optional and sometimes wrong. Fall back to the last keyframe
  // plus one segment.
  if (!(duration > lastKeyframe)) {
    duration = lastKeyframe + targetDuration;
  }

  return {
    version: MEDIA_INDEX_VERSION,
    fileName,
    fileLength: source.length,
    docType: layout.docType,
    timestampScale: layout.timestampScale,
    duration,
    firstClusterOffset: layout.firstClusterOffset,
    mediaEnd: layout.mediaEnd,
    ebmlHeader: layout.ebmlHeader.toString('base64'),
    info: layout.info.toString('base64'),
    tracks: layout.tracks,
    videoTrack: video.number,
    keyframes,
    segmentStarts: planSegments(
      keyframes.map((kf) => toSeconds(kf.ts)),
      duration,
      targetDuration,
    ),
    targetDuration,
  };
}

/**
 * Chooses segment boundaries from keyframe times: each segment runs at least
 * target seconds, taking the earlier keyframe when it lands closer to target
 * and is at least half of it. Returns indexes into keyframeTimes.
 */
function planSegments(
  keyframeTimes: number[],
  duration: number,
  target: number,
): number[] {
  const starts = [0];
  let segmentStart = 0;

  for (let k = 1; k < keyframeTimes.length; k++) {
    const length = keyframeTimes[k]! - segmentStart;
    if (length < target) {
      continue;
    }

    const prev = k - 1;
    const prevLength = keyframeTimes[prev]! - segmentStart;
    const pick =
      prev > starts.at(-1)! &&
      prevLength >= target / 2 &&
      target - prevLength < length - target
        ? prev
        : k;

    if (duration - keyframeTimes[pick]! < MIN_TAIL_SECONDS) {
      break;
    }
    starts.push(pick);
    segmentStart = keyframeTimes[pick]!;
    k = pick;
  }

  return starts;
}

export function ticksToSeconds(index: MediaIndex, ticks: number): number {
  return (ticks * index.timestampScale) / 1e9;
}

export function secondsToTicks(index: MediaIndex, seconds: number): number {
  return Math.round((seconds * 1e9) / index.timestampScale);
}

export function segmentCount(index: MediaIndex): number {
  return index.segmentStarts.length;
}

export function segmentStart(index: MediaIndex, n: number): number {
  return n === 0 ? 0 : ticksToSeconds(index, segmentKeyframe(index, n).ts);
}

export function segmentEnd(index: MediaIndex, n: number): number {
  return n + 1 < index.segmentStarts.length
    ? segmentStart(index, n + 1)
    : index.duration;
}

function segmentKeyframe(index: MediaIndex, n: number): Keyframe {
  const k = index.segmentStarts[n];
  const keyframe = k === undefined ? undefined : index.keyframes[k];
  if (!keyframe) {
    throw new RangeError(`Segment ${n} is out of range`);
  }
  return keyframe;
}

/**
 * Byte range and cut for segment n. tight trims the read to the closing
 * keyframe's block when the cue index placed it inside its cluster.
 */
export function keyframeSlice(
  index: MediaIndex,
  n: number,
  tight = true,
): SliceTarget {
  const start = n === 0 ? undefined : segmentKeyframe(index, n);
  const endK = index.segmentStarts[n + 1];
  const end = endK === undefined ? undefined : index.keyframes[endK];

  let readEnd = index.mediaEnd;
  if (end && endK !== undefined) {
    readEnd = nextClusterAfter(index, endK);
    if (tight && end.rel !== undefined) {
      readEnd = Math.min(readEnd, end.cluster + BOUNDARY_PEEK_BYTES + end.rel);
    }
  }

  return {
    readStart: start ? start.cluster : index.firstClusterOffset,
    readEnd,
    range: {
      mode: 'keyframes',
      startKeyframe: start?.ts ?? null,
      endKeyframe: end?.ts ?? null,
    },
  };
}

/**
 * Slice for a track with no keyframes of its own, cut on timestamps. The read
 * widens by the interleave slack unless the file is known to interleave tightly.
 */
export function timeSlice(
  index: MediaIndex,
  from: number,
  to: number | null,
  { tight = false }: { tight?: boolean } = {},
): SliceTarget {
  const slack = secondsToTicks(
    index,
    tight ? TIGHT_SLACK_SECONDS : INTERLEAVE_SLACK_SECONDS,
  );
  let readStart = index.firstClusterOffset;
  let readEnd = index.mediaEnd;

  for (const keyframe of index.keyframes) {
    if (keyframe.ts <= from - slack) {
      readStart = keyframe.cluster;
    } else if (to !== null && keyframe.ts > to + slack) {
      readEnd = keyframe.cluster;
      break;
    }
  }

  return {
    readStart,
    readEnd,
    range: { mode: 'time', from, to },
    verifyStart: tight,
  };
}

// Several keyframes can share a cluster, so walk on to the next distinct
// cluster offset.
function nextClusterAfter(index: MediaIndex, k: number): number {
  const cluster = index.keyframes[k]!.cluster;
  for (let i = k + 1; i < index.keyframes.length; i++) {
    const next = index.keyframes[i]!.cluster;
    if (next > cluster) {
      return Math.min(index.mediaEnd, next);
    }
  }
  return index.mediaEnd;
}
