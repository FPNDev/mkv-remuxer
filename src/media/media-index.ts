import type { ByteSource } from '../io/byte-source.js';
import { MatroskaError } from '../matroska/ebml.js';
import { readMatroskaLayout } from '../matroska/layout.js';
import { firstBlocks, type SliceRange } from '../matroska/slicer.js';
import type { MkvTrack } from '../matroska/tracks.js';
import { copyGrid, isCopiedAudio } from './codecs.js';

// Bump when the index shape changes. A cached index of another version is
// rebuilt from the file rather than read.
export const MEDIA_INDEX_VERSION = 7;

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
 * The frame grid a copied audio track is cut on, in samples at `rate`: frame
 * is one packet, lead how far past a segment's keyframe its audio starts.
 * origin is the presentation time in seconds of the track's first packet.
 */
export type AudioGrid = {
  rate: number;
  frame: number;
  lead: number;
  origin: number;
};

/**
 * A subtitle block the Cues index locates: ts and duration in ticks, cluster
 * an absolute file offset, rel the block's offset inside that cluster.
 */
export type SubtitleCue = {
  ts: number;
  duration: number;
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
  /** Keyed by track number, for every copied audio track. */
  audioGrids: Record<number, AudioGrid>;
  /** Frames per second the video packets run at, when they show it. */
  frameRate?: number | undefined;
  /**
   * Keyed by track number, for every subtitle track: its blocks the Cues
   * index gives a duration for, in time order.
   */
  subtitleCues: Record<number, SubtitleCue[]>;
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

// An AAC frame is 1024 samples. Segment boundaries snap to that grid so
// consecutive segments neither overlap nor leave a gap.
export const AAC_FRAME_SAMPLES = 1024;

// The first blocks of the copied audio tracks, and the video blocks the frame
// rate is measured on, are looked for this far into the clusters, the range
// the layout read already prefetches.
const FIRST_BLOCK_BYTES = 16 * 1024 * 1024;
const FRAME_RATE_FRAMES = 240;
// Matroska rounds every timestamp, so a measured rate this close to a whole
// or an NTSC rate is that rate.
const FRAME_RATE_TOLERANCE = 0.0005;

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

  const subtitleCues: Record<number, SubtitleCue[]> = {};
  const audioGrids: Record<number, AudioGrid> = {};
  const copied = new Set<number>();
  for (const track of layout.tracks) {
    if (isCopiedAudio(track)) {
      copied.add(track.number);
    }
    if (track.kind === 'subtitle') {
      subtitleCues[track.number] = [];
    }
  }
  for (const cue of layout.cues) {
    const list = subtitleCues[cue.track];
    if (list && cue.duration !== undefined) {
      list.push({
        ts: cue.time,
        duration: cue.duration,
        cluster: cue.clusterPosition,
        rel: cue.relativePosition,
      });
    }
  }
  for (const list of Object.values(subtitleCues)) {
    list.sort((a, b) => a.ts - b.ts);
  }
  const first = await firstBlocks(
    source.stream(
      layout.firstClusterOffset,
      Math.min(layout.mediaEnd, layout.firstClusterOffset + FIRST_BLOCK_BYTES),
    ),
    copied,
    video.number,
    FRAME_RATE_FRAMES,
  );
  for (const track of layout.tracks) {
    if (!copied.has(track.number)) {
      continue;
    }
    const block = first.blocks.get(track.number);
    audioGrids[track.number] = copyGrid(
      track,
      block && { seconds: toSeconds(block.ts), frame: block.frame },
    );
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
    audioGrids,
    frameRate: measuredFrameRate(first.video, layout.timestampScale),
    subtitleCues,
  };
}

// The mean gap between the presentation times of the first video blocks.
// Gaps longer than one and a half typical ones are dropped frames and left out.
function measuredFrameRate(
  ticks: number[],
  timestampScale: number,
): number | undefined {
  const sorted = ticks.toSorted((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i]! - sorted[i - 1]!);
  }
  if (gaps.length === 0) {
    return undefined;
  }
  const typical = gaps.toSorted((a, b) => a - b)[gaps.length >> 1]!;
  let total = 0;
  let frames = 0;
  for (const gap of gaps) {
    if (gap > 0 && gap <= typical * 1.5) {
      total += gap;
      frames++;
    }
  }
  if (frames === 0) {
    return undefined;
  }
  const rate = (frames * 1e9) / (total * timestampScale);
  for (const known of [Math.round(rate), Math.round(rate * 1.001) / 1.001]) {
    if (Math.abs(rate - known) <= known * FRAME_RATE_TOLERANCE) {
      return known;
    }
  }

  return rate;
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

export function aacSegmentStart(
  index: MediaIndex,
  rate: number,
  n: number,
): number {
  return (
    Math.round((segmentStart(index, n) * rate) / AAC_FRAME_SAMPLES) *
    AAC_FRAME_SAMPLES
  );
}

/**
 * Where the grid's frame boundaries fall relative to its first packet,
 * in seconds within half a frame of zero.
 */
export function gridPhase(grid: AudioGrid): number {
  const frame = grid.frame / grid.rate;

  return grid.origin - frame * Math.round(grid.origin / frame);
}

/**
 * Start of segment n of a copied track, in samples at the grid rate. It is
 * the first frame boundary that every packet owned by the segment follows
 * the segment's keyframe on, so the segment is read from that keyframe.
 */
export function copySegmentStart(
  index: MediaIndex,
  grid: AudioGrid,
  n: number,
): number {
  if (n === 0) {
    return 0;
  }
  const offset = (segmentStart(index, n) - gridPhase(grid)) * grid.rate;

  return Math.ceil((offset + grid.lead) / grid.frame) * grid.frame;
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
