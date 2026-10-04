import { createWriteStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { Writable } from 'node:stream';

import type { ByteSource } from '../io/byte-source.js';
import { errorMessage, type Logger } from '../logger.js';
import {
  buildTrackHeader,
  EMPTY_CLUSTER,
  sliceMatroska,
  type SliceResult,
} from '../matroska/slicer.js';
import {
  aacChannels,
  aacSampleRate,
  type AudioRendition,
  type Rendition,
  type VideoRendition,
} from '../media/codecs.js';
import {
  keyframeSlice,
  secondsToTicks,
  segmentCount,
  segmentStart,
  ticksToSeconds,
  timeSlice,
  type MediaIndex,
  type SliceTarget,
} from '../media/media-index.js';
import { tempPathFor, writeFileAtomic } from '../util/fs.js';
import { FfmpegSupervisor } from './ffmpeg.js';
import {
  Fmp4Splitter,
  hasTopLevelBox,
  retimeFragment,
  trackTimescale,
} from './mp4.js';

// Every output timestamp is shifted by this much, so a segment whose first
// frame precedes its own start still carries non-negative times.
export const TIMELINE_OFFSET_SECONDS = 10;

// An AAC frame is 1024 samples. Segment boundaries snap to that grid so
// consecutive segments neither overlap nor leave a gap.
const AAC_FRAME_SAMPLES = 1024;
// The encoder needs frames before the boundary to settle. They are encoded
// and then dropped, so the segment holds only its own samples.
const AUDIO_PAD_FRAMES = 16;
// Cluster timestamps do not fall on the sample grid, so the read is widened
// on both sides of the encode range.
const AUDIO_READ_MARGIN_SECONDS = 0.25;

// The sliced input carries one track, so it is always stream 0. -copyts
// keeps the source timestamps the slice boundaries are expressed in.
const INPUT_ARGS = ['-copyts', '-f', 'matroska', '-i', 'pipe:0', '-map', '0:0'];

// Each segment must be one self-contained fragment: no trailer, no edit
// list, no inherited metadata, and marked as discontinuous with zero.
const FMP4_OUTPUT_ARGS = [
  '-output_ts_offset',
  String(TIMELINE_OFFSET_SECONDS),
  '-avoid_negative_ts',
  'disabled',
  '-map_metadata',
  '-1',
  '-map_chapters',
  '-1',
  '-fflags',
  '+bitexact',
  '-f',
  'mp4',
  '-movflags',
  '+frag_custom+empty_moov+default_base_moof+frag_discont+skip_trailer',
  '-use_editlist',
  '0',
  'pipe:1',
];

const WEBVTT_OUTPUT_ARGS = ['-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'];

export type RemuxTarget = {
  index: MediaIndex;
  source: ByteSource;
  rendition: Rendition;
  signal?: AbortSignal | undefined;
};

export type InterleavingNotes = {
  load(): Promise<string[]>;
  save(files: string[]): void;
};

export type RemuxerOptions = {
  ffmpegPath: string;
  timeoutMs: number;
  audioReadFromKeyframe: boolean;
  notes?: InterleavingNotes | undefined;
  logger: Logger;
};

const MAX_REMEMBERED_FILES = 4096;

type Plan = {
  slices: SliceTarget[];
  args: string[];
};

export class Remuxer {
  // Files whose blocks sit far from the cluster headers that reference them.
  // A tight read misses the boundary there, so those files are read wide.
  readonly looselyInterleaved = new Set<string>();
  private readonly ffmpeg: FfmpegSupervisor;

  constructor(private readonly options: RemuxerOptions) {
    this.ffmpeg = new FfmpegSupervisor(options.ffmpegPath);
  }

  async restoreNotes(): Promise<void> {
    const saved = await this.options.notes?.load();
    for (const file of saved ?? []) {
      this.looselyInterleaved.add(file);
    }
  }

  killAll(): void {
    this.ffmpeg.killAll();
  }

  async writeInit(
    index: MediaIndex,
    rendition: Rendition,
    outPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (rendition.type === 'subtitle') {
      throw new Error('Subtitle renditions have no init segment');
    }

    // A transcoded track's init segment must describe the AAC output, not the
    // source codec, so it comes from a fraction of a second of silence.
    const converted = rendition.type === 'audio' && rendition.transcode;
    const splitter = new Fmp4Splitter();
    // Only the init boxes are wanted. The media side is drained so the splitter
    // does not stall ffmpeg on backpressure.
    splitter.resume();
    await this.ffmpeg.run({
      args: converted ? silenceArgs(rendition) : copyArgs(rendition),
      input: converted
        ? undefined
        : [Buffer.concat([trackHeader(index, rendition), EMPTY_CLUSTER])],
      output: splitter,
      signal,
      timeoutMs: this.options.timeoutMs,
    });

    const init = splitter.init;
    if (!hasTopLevelBox(init, 'moov')) {
      throw new Error('ffmpeg produced no moov box');
    }
    signal?.throwIfAborted();
    await writeFileAtomic(outPath, init);
  }

  // One short read is enough to mark the file. Later segments skip the tight
  // slice instead of paying for a failed attempt first.
  private noteShortRead(slice: SliceTarget, file: string): void {
    if (!slice.verifyStart || this.looselyInterleaved.has(file)) {
      return;
    }
    this.looselyInterleaved.add(file);
    while (this.looselyInterleaved.size > MAX_REMEMBERED_FILES) {
      this.looselyInterleaved.delete(
        this.looselyInterleaved.values().next().value!,
      );
    }
    this.options.notes?.save([...this.looselyInterleaved]);
    this.options.logger.info(
      'Blocks are stored far from their clusters; reading wider',
      {
        file,
      },
    );
  }

  async writeSegment(
    target: RemuxTarget,
    n: number,
    outPath: string,
  ): Promise<void> {
    const planned = plan(
      target.index,
      target.rendition,
      n,
      this.options.audioReadFromKeyframe,
    );
    const { args } = planned;
    const file = `${target.index.fileName}:${target.index.fileLength}`;
    const slices = this.looselyInterleaved.has(file)
      ? planned.slices.filter((slice) => !slice.verifyStart)
      : planned.slices;

    // The tight slice comes first and the wider one is the fallback, so a
    // well-interleaved file reads the least data possible.
    for (const [attempt, slice] of slices.entries()) {
      const canRetry = attempt < slices.length - 1;

      if (target.rendition.type === 'subtitle') {
        const chunks: Buffer[] = [];
        const collector = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        });
        const result = await this.run(target, slice, args, collector);
        if (!isComplete(target.index, slice, result)) {
          this.noteShortRead(slice, file);
          if (canRetry) {
            continue;
          }
          throw boundaryError(n);
        }
        target.signal?.throwIfAborted();
        await writeFileAtomic(outPath, toHlsWebVtt(Buffer.concat(chunks)));
        return;
      }

      const temp = tempPathFor(outPath);
      const splitter = new Fmp4Splitter();
      try {
        const result = await this.run(target, slice, args, [
          splitter,
          createWriteStream(temp),
        ]);
        if (!isComplete(target.index, slice, result)) {
          this.noteShortRead(slice, file);
          if (canRetry) {
            continue;
          }
          throw boundaryError(n);
        }
        target.signal?.throwIfAborted();
        if (target.rendition.type === 'video') {
          await retimeSegment(
            temp,
            splitter.init,
            target.index,
            result.timestamps,
            this.options.logger,
          );
        }
        await rename(temp, outPath);
        return;
      } finally {
        await rm(temp, { force: true });
      }
    }
  }

  private async run(
    target: RemuxTarget,
    slice: SliceTarget,
    args: string[],
    output: Writable | Writable[],
  ): Promise<SliceResult> {
    const { index, source, rendition, signal } = target;
    const readable = source.stream(slice.readStart, slice.readEnd);
    const { stream, result } = sliceMatroska(readable, {
      header: trackHeader(index, rendition),
      track: rendition.track.number,
      videoTrack: index.videoTrack,
      range: slice.range,
    });

    try {
      await this.ffmpeg.run({
        args,
        input: stream,
        output,
        signal,
        timeoutMs: this.options.timeoutMs,
      });
      return result;
    } finally {
      readable.destroy();
    }
  }
}

function plan(
  index: MediaIndex,
  rendition: Rendition,
  n: number,
  fromKeyframe: boolean,
): Plan {
  const keyframeSlices = [
    keyframeSlice(index, n, true),
    keyframeSlice(index, n, false),
  ];

  switch (rendition.type) {
    case 'video':
      return { slices: keyframeSlices, args: copyArgs(rendition) };
    case 'audio': {
      if (rendition.transcode) {
        return aacPlan(index, rendition, n, fromKeyframe);
      }
      const startK = index.segmentStarts[n];
      const endK = index.segmentStarts[n + 1];
      const from =
        n === 0 || startK === undefined
          ? Number.NEGATIVE_INFINITY
          : index.keyframes[startK]!.ts;
      const to = endK === undefined ? null : index.keyframes[endK]!.ts;
      const slice = keyframeAudioSlice(
        index,
        n,
        to,
        timeSlice(index, from, to, { tight: true }),
      );
      return {
        slices: [
          slice,
          { ...slice, readEnd: keyframeSlice(index, n, false).readEnd },
        ],
        args: copyArgs(rendition),
      };
    }
    case 'subtitle':
      return {
        slices: keyframeSlices,
        args: [...INPUT_ARGS, ...WEBVTT_OUTPUT_ARGS],
      };
  }
}

function trackHeader(index: MediaIndex, rendition: Rendition): Buffer {
  return buildTrackHeader(
    Buffer.from(index.ebmlHeader, 'base64'),
    Buffer.from(index.info, 'base64'),
    Buffer.from(rendition.track.entry, 'base64'),
  );
}

function copyArgs(rendition: VideoRendition | AudioRendition): string[] {
  // HEVC in fMP4 must carry the hvc1 tag; players reject hev1 here.
  const tag =
    rendition.type === 'video' && rendition.codec === 'hevc'
      ? ['-tag:v', 'hvc1']
      : [];
  return [...INPUT_ARGS, '-c', 'copy', ...tag, ...FMP4_OUTPUT_ARGS];
}

function aacOutput(rendition: AudioRendition): {
  rate: number;
  channels: number;
  args: string[];
} {
  const rate = aacSampleRate(rendition.track);
  const channels = aacChannels(rendition.track);
  return {
    rate,
    channels,
    args: [
      '-c:a',
      'aac',
      '-ac',
      String(channels),
      '-b:a',
      aacBitrate(channels),
    ],
  };
}

function aacBitrate(channels: number): string {
  switch (channels) {
    case 1:
      return '96k';
    case 2:
      return '192k';
    default:
      return `${64 * channels}k`;
  }
}

function silenceArgs(rendition: AudioRendition): string[] {
  const { rate, channels, args } = aacOutput(rendition);
  return [
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=${rate}:cl=${channels > 1 ? 'stereo' : 'mono'}`,
    '-t',
    '0.1',
    '-map',
    '0:0',
    ...args,
    ...FMP4_OUTPUT_ARGS,
  ];
}

function aacPlan(
  index: MediaIndex,
  rendition: AudioRendition,
  n: number,
  fromKeyframe: boolean,
): Plan {
  const { rate, args: outputArgs } = aacOutput(rendition);
  const toGrid = (seconds: number) =>
    Math.round((seconds * rate) / AAC_FRAME_SAMPLES) * AAC_FRAME_SAMPLES;
  const padding = AUDIO_PAD_FRAMES * AAC_FRAME_SAMPLES;

  const isLast = n + 1 >= segmentCount(index);
  const start = toGrid(segmentStart(index, n));
  const end = isLast ? null : toGrid(segmentStart(index, n + 1));
  const encodeFrom = Math.max(0, start - padding);
  const encodeTo = end === null ? null : end + padding;

  const toTicks = (samples: number, marginSeconds: number) =>
    secondsToTicks(index, samples / rate + marginSeconds);
  const from = toTicks(encodeFrom, -AUDIO_READ_MARGIN_SECONDS);
  const to =
    encodeTo === null ? null : toTicks(encodeTo, AUDIO_READ_MARGIN_SECONDS);

  const filters: string[] = [];
  if (fromKeyframe) {
    filters.push(`aresample=${rate}:async=1:first_pts=${encodeFrom}`);
  } else if (rendition.track.sampleRate !== rate) {
    filters.push(`aresample=${rate}`);
  }
  filters.push(
    `atrim=start_pts=${encodeFrom}` +
      (encodeTo === null ? '' : `:end_pts=${encodeTo}`),
  );

  // Frames outside the segment were encoded for context. The bitstream filter
  // drops them by presentation timestamp.
  const drop =
    `lt(pts\\,${start})` + (end === null ? '' : `+gte(pts\\,${end})`);

  const tight = timeSlice(index, from, to, { tight: true });
  return {
    slices: [
      ...(fromKeyframe ? [keyframeAudioSlice(index, n, to, tight)] : []),
      tight,
      timeSlice(index, from, to),
    ],
    args: [
      ...INPUT_ARGS,
      '-af',
      filters.join(','),
      ...outputArgs,
      '-bsf:a',
      `noise=drop=${drop}`,
      ...FMP4_OUTPUT_ARGS,
    ],
  };
}

function keyframeAudioSlice(
  index: MediaIndex,
  n: number,
  to: number | null,
  tight: SliceTarget,
): SliceTarget {
  const k = index.segmentStarts[n];
  const keyframe = n === 0 || k === undefined ? undefined : index.keyframes[k];
  let readEnd = tight.readEnd;
  if (to !== null) {
    for (const [i, next] of index.keyframes.entries()) {
      if (next.ts <= to) {
        continue;
      }
      const prev = index.keyframes[i - 1];
      if (prev && next.ts > prev.ts) {
        const share = (to - prev.ts) / (next.ts - prev.ts);
        readEnd = Math.min(
          readEnd,
          prev.cluster +
            Math.ceil(
              (next.cluster - prev.cluster) * Math.min(1, share * 1.5 + 0.4),
            ),
        );
      }
      break;
    }
  }
  return {
    ...tight,
    readStart: keyframe ? keyframe.cluster : index.firstClusterOffset,
    readEnd,
    verifyStart: false,
  };
}

// A run is complete when the wanted range was found in the bytes read.
// ffmpeg exits zero on a short read too.
function isComplete(
  index: MediaIndex,
  slice: SliceTarget,
  result: SliceResult,
): boolean {
  if (!result.started) {
    return false;
  }
  const { range } = slice;

  if (range.mode === 'keyframes') {
    return range.endKeyframe === null || result.reachedEnd;
  }
  if (
    slice.verifyStart &&
    slice.readStart > index.firstClusterOffset &&
    (result.firstTrackTs === null || result.firstTrackTs > range.from)
  ) {
    return false;
  }
  if (range.to === null || result.reachedEnd || !result.sourceEnded) {
    return true;
  }
  return slice.readEnd >= index.mediaEnd;
}

// A failed timing correction keeps ffmpeg's timestamps rather than failing
// the segment.
async function retimeSegment(
  file: string,
  init: Buffer,
  index: MediaIndex,
  timestamps: number[],
  logger: Logger,
): Promise<void> {
  const handle = await open(file, 'r+');
  try {
    const header = Buffer.alloc(8);
    await handle.read(header, 0, 8, 0);
    const moof = Buffer.alloc(header.readUInt32BE(0));
    await handle.read(moof, 0, moof.length, 0);
    try {
      const scale = trackTimescale(init);
      const pts = timestamps.map((ticks) =>
        Math.round(
          (ticksToSeconds(index, ticks) + TIMELINE_OFFSET_SECONDS) * scale,
        ),
      );
      retimeFragment(moof, pts);
    } catch (err) {
      logger.warn('Segment keeps ffmpeg timestamps', {
        file,
        error: errorMessage(err),
      });
      return;
    }
    await handle.write(moof, 0, moof.length, 0);
  } finally {
    await handle.close();
  }
}

function boundaryError(n: number): Error {
  return new Error(`Segment ${n} boundaries were not found in the file data`);
}

// HLS aligns WebVTT to the other renditions through X-TIMESTAMP-MAP, in
// 90 kHz MPEG ticks.
function toHlsWebVtt(output: Buffer): string {
  const body = output
    .toString('utf8')
    .replace(/^﻿?WEBVTT[^\n]*\n?/u, '')
    .replace(/^\n+/u, '');
  const mpegTs = TIMELINE_OFFSET_SECONDS * 90000;
  return `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegTs},LOCAL:00:00:00.000\n\n${body}`;
}
