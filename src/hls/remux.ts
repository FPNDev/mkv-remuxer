import { createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Writable, type Transform } from 'node:stream';

import type { ByteSource } from '../io/byte-source.js';
import { errorMessage, type Logger } from '../logger.js';
import {
  blockCluster,
  buildTrackHeader,
  EMPTY_CLUSTER,
  sliceMatroska,
  type SliceResult,
} from '../matroska/slicer.js';
import {
  aacChannels,
  aacFold,
  aacSampleRate,
  packetSamples,
  silenceEncoders,
  silenceSizes,
  type AudioRendition,
  type Rendition,
  type SubtitleRendition,
  type VideoRendition,
} from '../media/codecs.js';
import {
  AAC_FRAME_SAMPLES,
  aacSegmentStart,
  copySegmentStart,
  gridPhase,
  keyframeSlice,
  secondsToTicks,
  segmentCount,
  segmentStart,
  ticksToSeconds,
  timeSlice,
  type AudioGrid,
  type MatroskaIndex,
  type MediaIndex,
  type SliceTarget,
  type SubtitleCue,
} from '../media/media-index.js';
import { exists, tempPathFor, writeFileAtomic } from '../util/fs.js';
import { FfmpegSupervisor } from './ffmpeg.js';
import {
  addSampleEntryBox,
  Fmp4Splitter,
  hasTopLevelBox,
  readFragments,
  TIMELINE_OFFSET_SECONDS,
  trackTimescale,
  writeFragment,
  type FragmentSample,
} from './mp4.js';
import {
  loadSamples,
  MP4_INPUT_ARGS,
  mp4DecodeInput,
  mp4Init,
  mp4SubtitleSegment,
  mp4VideoSegment,
  segmentSamples,
  SYNC_FLAGS,
  type Mp4Target,
} from './mp4-remux.js';

// The encoder needs frames before the boundary to settle. They are encoded
// and then dropped, so the segment holds only its own samples.
const AUDIO_PAD_FRAMES = 16;
// Cluster timestamps do not fall on the sample grid, so the read is widened
// on both sides of the encode range.
const AUDIO_READ_MARGIN_SECONDS = 0.25;
// Matroska rounds timestamps to the millisecond, so a clean track jitters by
// up to 1 ms. A larger offset from the sample count is a hole or drift, and
// it is filled with silence or trimmed.
const AUDIO_SYNC_TOLERANCE_SECONDS = 0.002;

// Layouts the AAC encoder accepts, per channel count. A decoded layout that
// is not listed becomes the closest listed one of the same count. Side
// surrounds come out as back ones, which AAC signals with a channel config
// instead of a program config element.
const AAC_LAYOUTS: Record<number, string> = {
  1: 'mono',
  2: 'stereo',
  3: '3.0|2.1|3.0(back)',
  4: '4.0|quad|quad(side)|3.1',
  5: '5.0|4.1',
  6: '5.1|6.0|6.0(front)|hexagonal',
  7: '6.1|6.1(back)|6.1(front)|7.0|7.0(front)',
  8: '7.1|7.1(wide)|7.1(wide-side)|octagonal',
};
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

// The sliced input carries one track, so it is always stream 0. -copyts
// keeps the source timestamps the slice boundaries are expressed in.
const INPUT_ARGS = ['-copyts', '-f', 'matroska', '-i', 'pipe:0', '-map', '0:0'];

const FMP4_MOVFLAGS =
  '+frag_custom+empty_moov+default_base_moof+frag_discont+skip_trailer';

// Each segment must be one self-contained fragment: no trailer, no edit
// list, no inherited metadata, and marked as discontinuous with zero.
const fmp4OutputArgs = (movflags: string, output = 'pipe:1') => [
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
  movflags,
  '-use_editlist',
  '0',
  output,
];
const FMP4_OUTPUT_ARGS = fmp4OutputArgs(FMP4_MOVFLAGS);
// ffmpeg writes a colr box only for a full colour description. The flag has
// it write one from whatever the source states, a range alone included.
const VIDEO_OUTPUT_ARGS = fmp4OutputArgs(`${FMP4_MOVFLAGS}+write_colr`);
// ffmpeg writes the AC-3, E-AC-3 and TrueHD sample entries from the first
// packet, so the moov has to wait for it. Other copied audio is unaffected.
const COPIED_AUDIO_MOVFLAGS = `${FMP4_MOVFLAGS}+delay_moov`;
// Frames ffmpeg encodes to model copied audio's silence on. TrueHD keeps
// them all, as a run that starts on a major sync.
const SILENCE_FRAMES = 8;
const TRUEHD_SILENCE_FRAMES = 1200;
// The same codecs get no usable init segment from a track header alone.
const INIT_FROM_PACKET_AUDIO = /^(A_AC3|A_EAC3|A_TRUEHD)$/u;
// MP4 packets probed for a transcoded track's channel layout. TrueHD decodes
// from its first major sync, which opens the track.
const PROBE_SAMPLES = 16;

const WEBVTT_OUTPUT_ARGS = ['-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'];

// Matroska and the fiel box number field orders alike.
const FIELD_ORDERS = new Set([1, 6, 9, 14]);

export type RemuxTarget<I extends MediaIndex = MediaIndex> = {
  index: I;
  source: ByteSource;
  rendition: Rendition;
  signal?: AbortSignal | undefined;
  /** Where the sample tables of an MP4 file are. */
  sampleDir: string;
};

type MatroskaTarget = RemuxTarget<MatroskaIndex>;

/**
 * What an init segment is written for. source is needed only when
 * initNeedsPacket holds for the rendition.
 */
export type InitTarget = Omit<RemuxTarget, 'source'> & {
  source?: ByteSource | undefined;
};

export type InterleavingNotes = {
  load(): Promise<string[]>;
  save(files: string[]): void;
};

export type AacCoder = 'fast' | 'twoloop';

export type RemuxerOptions = {
  ffmpegPath: string;
  timeoutMs: number;
  audioReadFromKeyframe: boolean;
  aacCoder: AacCoder;
  notes?: InterleavingNotes | undefined;
  logger: Logger;
};

const MAX_REMEMBERED_FILES = 4096;

type Plan = {
  slices: SliceTarget[];
  args: string[];
  /** For a transcoded track: encodes the segment from silence alone. */
  silence?: string[];
};

/**
 * readAll: the byte source delivered the whole planned range. Only then does
 * a slice without the track's blocks prove the track has none there.
 */
type SliceRun = SliceResult & { readAll: boolean };

/** A copied packet. time and length are in the track timescale. */
type TimedSample = FragmentSample & {
  time: number;
  length: number;
};

/**
 * A copied track's frame grid in its timescale. jitter bounds how far a
 * packet's timestamp sits from its true time; packets whose timestamps round
 * alike recur every period frames.
 */
type Lattice = {
  frame: number;
  phase: number;
  jitter: number;
  period: number;
};

type Placement = {
  position: number;
  sample: TimedSample;
};

/** Silent frames for a copied track, timed in its timescale. */
type CopySilence = {
  timescale: number;
  fill(length: number): Promise<FragmentSample[]>;
};

/** A real packet of a copied track to model its silence on. */
type SilenceReference = {
  packet: Buffer;
  timescale: number;
};

/**
 * ffmpeg arguments that encode one AAC segment, and those that encode it
 * from silence alone. from and to bound, in seconds, the source audio the
 * encode reads; to is null for the last segment.
 */
type AacEncode = {
  args: string[];
  silence: string[];
  from: number;
  to: number | null;
};

/** The AAC channel layout, and the filter that turns decoded audio into it. */
type AacLayout = {
  layout: string;
  filter: string;
};

export class Remuxer {
  // Files whose blocks sit far from the cluster headers that reference them.
  // A tight read misses the boundary there, so those files are read wide.
  readonly looselyInterleaved = new Set<string>();
  // AAC layout per file and track, decoded once so every segment and the
  // init segment carry the same AudioSpecificConfig.
  private readonly aacLayouts = new Map<string, Promise<AacLayout>>();
  // Silence per file and track for copied audio, modelled on a real packet.
  private readonly copySilences = new Map<string, Promise<CopySilence>>();
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

  /**
   * Writes the init segment. A rendition for which initNeedsPacket holds
   * needs `source`: its init is cut from the track's first packet, or, when
   * transcoded, follows the layout decoded from that packet. A copied track
   * of an MP4 file wraps its own sample entry.
   */
  async writeInit(target: InitTarget, outPath: string): Promise<void> {
    const { index, rendition, signal, source } = target;
    if (rendition.type === 'subtitle') {
      throw new Error('Subtitle renditions have no init segment');
    }

    const splitter = new Fmp4Splitter();
    // Only the init boxes are wanted. The media side is drained so the splitter
    // does not stall ffmpeg on backpressure.
    splitter.resume();
    const language = rendition.track.iso639Language;
    let init: Buffer;
    if (rendition.type === 'audio' && rendition.transcode) {
      if (!source) {
        throw new Error('A transcoded init segment needs its source');
      }
      // A transcoded track's init segment must describe the AAC output, not
      // the source codec, so it comes from a fraction of a second of silence.
      const { layout } = await this.aacLayout({ ...target, source });
      await this.ffmpeg.run({
        args: withLanguage(
          silenceArgs(rendition, layout, this.options.aacCoder),
          language,
        ),
        output: splitter,
        signal,
        timeoutMs: this.options.timeoutMs,
      });
      init = splitter.init;
    } else if (index.container === 'mp4') {
      init = mp4Init(index, rendition);
    } else if (source && initNeedsPacket(rendition)) {
      await this.run(
        { ...target, index, source },
        timeSlice(index, Number.NEGATIVE_INFINITY, null),
        withLanguage(audioCopyArgs(rendition, ['-frames:a', '1']), language),
        splitter,
      );
      init = splitter.init;
    } else {
      await this.ffmpeg.run({
        args: withLanguage(copyArgs(rendition), language),
        input: [Buffer.concat([trackHeader(index, rendition), EMPTY_CLUSTER])],
        output: splitter,
        signal,
        timeoutMs: this.options.timeoutMs,
      });
      init = splitter.init;
    }

    if (!hasTopLevelBox(init, 'moov')) {
      throw new Error('ffmpeg produced no moov box');
    }
    // ffmpeg writes no fiel box for some codecs, H.264 among them.
    const fields = rendition.type === 'video' ? fieldBox(rendition) : undefined;
    if (fields) {
      init = addSampleEntryBox(init, 'fiel', fields);
    }
    signal?.throwIfAborted();
    await writeFileAtomic(outPath, init);
  }

  // The probe is shared by every segment of the track, so no single caller's
  // signal stops it. Each caller still holds its own lease while it waits.
  private aacLayout(target: RemuxTarget): Promise<AacLayout> {
    const { index, rendition } = target;
    const fold = aacFold(rendition.track);
    if (fold) {
      return Promise.resolve({
        layout: fold.layout,
        filter: `pan=${fold.layout}|${fold.mix}`,
      });
    }

    const key = `${index.fileName}:${index.fileLength}:${rendition.track.number}`;
    let layout = this.aacLayouts.get(key);
    if (!layout) {
      layout = this.probeAacLayout({ ...target, signal: undefined });
      layout.catch(() => {
        this.aacLayouts.delete(key);
      });
      this.aacLayouts.set(key, layout);
      while (this.aacLayouts.size > MAX_REMEMBERED_FILES) {
        this.aacLayouts.delete(this.aacLayouts.keys().next().value!);
      }
    }

    return layout;
  }

  // Decodes the track's first frame into the closest accepted layout and reads
  // that layout back from the WAV channel mask.
  private async probeAacLayout(target: RemuxTarget): Promise<AacLayout> {
    const { index, rendition } = target;
    const chunks: Buffer[] = [];
    const collector = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    const decode = [
      '-af',
      `aformat=channel_layouts=${AAC_LAYOUTS[aacChannels(rendition.track)]}`,
      '-frames:a',
      '1',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      'pipe:1',
    ];
    if (index.container === 'mp4') {
      await this.ffmpeg.run({
        args: [...MP4_INPUT_ARGS, ...decode],
        input: await mp4DecodeInput({ ...target, index }, 0, PROBE_SAMPLES),
        output: collector,
        timeoutMs: this.options.timeoutMs,
      });
    } else {
      await this.run(
        { ...target, index },
        timeSlice(index, Number.NEGATIVE_INFINITY, null),
        [...INPUT_ARGS, ...decode],
        collector,
      );
    }

    const wav = Buffer.concat(chunks);
    if (wav.length < 44 || wav.toString('latin1', 12, 16) !== 'fmt ') {
      throw new Error(
        `Track ${rendition.track.number} decoded to no audio for its AAC layout`,
      );
    }
    // A mono or stereo WAV carries no channel mask.
    let layout = wav.readUInt16LE(22) === 1 ? 'mono' : 'stereo';
    if (wav.readUInt16LE(20) === WAVE_FORMAT_EXTENSIBLE) {
      layout = `0x${wav.readUInt32LE(40).toString(16)}`;
    }

    return { layout, filter: `aformat=channel_layouts=${layout}` };
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

  writeSegment(
    target: RemuxTarget,
    n: number,
    outPath: string,
  ): Promise<void> {
    const { index } = target;

    return index.container === 'mp4'
      ? this.writeMp4Segment({ ...target, index }, n, outPath)
      : this.writeMatroskaSegment({ ...target, index }, n, outPath);
  }

  private async writeMp4Segment(
    target: Mp4Target,
    n: number,
    outPath: string,
  ): Promise<void> {
    const { rendition, signal } = target;
    switch (rendition.type) {
      case 'video': {
        const fragment = await mp4VideoSegment(target, rendition, n);
        signal?.throwIfAborted();
        await writeFileAtomic(outPath, fragment);

        return;
      }
      case 'subtitle': {
        const cues = await mp4SubtitleSegment(target, rendition, n);
        signal?.throwIfAborted();
        await writeFileAtomic(outPath, toHlsWebVtt(cues));

        return;
      }
      case 'audio':
        return rendition.transcode
          ? this.writeMp4Aac(target, rendition, n, outPath)
          : this.writeMp4CopiedAudio(target, rendition, n, outPath);
    }
  }

  // Copied MP4 audio keeps its packets at their own times. A hole of more
  // than half a packet becomes silence, so the segment covers its whole
  // playlist range.
  private async writeMp4CopiedAudio(
    target: Mp4Target,
    rendition: AudioRendition,
    n: number,
    outPath: string,
  ): Promise<void> {
    const { index } = target;
    const { track } = rendition;
    const samples = index.samples[track.number]!;
    const { timescale } = samples;
    const [from, to] = segmentSamples(index, samples, n);
    const { records, data } = await loadSamples(target, from, to);
    const start = samples.starts[n]!;
    const end =
      n + 1 < segmentCount(index)
        ? samples.starts[n + 1]!
        : Math.round(index.duration * timescale);
    const grid: AudioGrid = {
      rate: track.sampleRate ?? timescale,
      frame: samples.frame ?? AAC_FRAME_SAMPLES,
      lead: 0,
      origin: 0,
    };
    const half = (grid.frame * timescale) / grid.rate / 2;
    const silence = () =>
      this.copySilence(index, rendition, grid, () =>
        this.firstMp4Packet({ ...target, signal: undefined }),
      );

    const out: FragmentSample[] = [];
    let at = start;
    for (const [i, record] of records.entries()) {
      const shown = record.dts + record.cto;
      // It overlaps what is already placed.
      if (shown < at - half) {
        continue;
      }
      if (shown > at + half) {
        out.push(...(await (await silence()).fill(shown - at)));
        at = shown;
      }
      out.push({
        dts: at,
        duration: record.duration,
        flags: SYNC_FLAGS,
        data: data[i]!,
      });
      at += record.duration;
    }
    if (at < end) {
      out.push(...(await (await silence()).fill(end - at)));
    }
    target.signal?.throwIfAborted();
    await writeFileAtomic(
      outPath,
      writeFragment(start + TIMELINE_OFFSET_SECONDS * timescale, out),
    );
  }

  private async firstMp4Packet(target: Mp4Target): Promise<SilenceReference> {
    const { data } = await loadSamples(target, 0, 1);
    const packet = data[0];
    if (!packet) {
      throw new Error(
        `Track ${target.rendition.track.number} has no packet to model silence on`,
      );
    }

    return {
      packet,
      timescale: target.index.samples[target.rendition.track.number]!.timescale,
    };
  }

  // The source window around the segment is read whole segments at a time,
  // and the encode trims it to the segment.
  private async writeMp4Aac(
    target: Mp4Target,
    rendition: AudioRendition,
    n: number,
    outPath: string,
  ): Promise<void> {
    const { index, signal } = target;
    const samples = index.samples[rendition.track.number]!;
    const count = segmentCount(index);
    const encode = aacEncode(
      index,
      rendition,
      n,
      await this.aacLayout(target),
      this.options.aacCoder,
      MP4_INPUT_ARGS,
    );
    const seconds = (k: number) => samples.starts[k]! / samples.timescale;
    let first = n;
    while (first > 0 && seconds(first) > encode.from) {
      first--;
    }
    let past = n + 1;
    while (past < count && (encode.to === null || seconds(past) < encode.to)) {
      past++;
    }
    const input = await mp4DecodeInput(
      target,
      samples.first[first]!,
      past < count ? samples.first[past]! : samples.count,
    );

    const temp = tempPathFor(outPath);
    try {
      if (input.length > 1) {
        await this.ffmpeg.run({
          args: encode.args,
          input,
          output: [new Fmp4Splitter(), createWriteStream(temp)],
          signal,
          timeoutMs: this.options.timeoutMs,
        });
      }
      // The window holds no decodable audio at all.
      if (input.length === 1 || (await stat(temp)).size === 0) {
        await this.ffmpeg.run({
          args: encode.silence,
          output: [new Fmp4Splitter(), createWriteStream(temp)],
          signal,
          timeoutMs: this.options.timeoutMs,
        });
      }
      signal?.throwIfAborted();
      await rename(temp, outPath);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private async writeMatroskaSegment(
    target: MatroskaTarget,
    n: number,
    outPath: string,
  ): Promise<void> {
    const { rendition } = target;
    if (rendition.type === 'audio' && !rendition.transcode) {
      return this.writeCopiedAudio(target, rendition, n, outPath);
    }
    const converted = rendition.type === 'audio';
    const planned = converted
      ? aacPlan(
          target.index,
          rendition,
          n,
          this.options.audioReadFromKeyframe,
          await this.aacLayout(target),
          this.options.aacCoder,
        )
      : plan(target.index, rendition, n);
    const { args, silence } = planned;
    const file = `${target.index.fileName}:${target.index.fileLength}`;
    const slices = this.looselyInterleaved.has(file)
      ? planned.slices.filter((slice) => !slice.verifyStart)
      : planned.slices;
    const carried =
      rendition.type === 'subtitle' ? await this.carriedCues(target, n) : [];

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
        const result = await this.run(target, slice, args, collector, carried);
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
        let result: SliceRun;
        try {
          result = await this.run(target, slice, args, [
            splitter,
            createWriteStream(temp),
          ]);
        } catch (err) {
          // A narrow slice may hold only TrueHD frames that come before any
          // major sync, which ffmpeg can't decode. A wider one can.
          if (converted && canRetry && !target.signal?.aborted) {
            continue;
          }
          throw err;
        }
        if (!isComplete(target.index, slice, result)) {
          this.noteShortRead(slice, file);
          if (canRetry) {
            continue;
          }
          // A transcoded track may have no audio left in the window. Only a
          // window read to its end shows that, and its silence is then right.
          if (!converted || !result.readAll) {
            throw boundaryError(n);
          }
        }
        target.signal?.throwIfAborted();
        if (silence && (await stat(temp)).size === 0) {
          // The window holds no decodable audio at all. That is only a gap
          // when the read reached the end of the segment's range.
          if (!result.reachedEnd && !result.readAll) {
            throw boundaryError(n);
          }
          await this.ffmpeg.run({
            args: silence,
            output: [new Fmp4Splitter(), createWriteStream(temp)],
            signal: target.signal,
            timeoutMs: this.options.timeoutMs,
          });
          target.signal?.throwIfAborted();
        }
        if (rendition.type === 'video') {
          await retimeSegment(
            temp,
            splitter.init,
            target.index,
            n,
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

  // Copied audio keeps every source packet as it is and puts it on the track's
  // frame grid. Frames the source lacks become silence, so the segment covers
  // its whole playlist range.
  private async writeCopiedAudio(
    target: MatroskaTarget,
    rendition: AudioRendition,
    n: number,
    outPath: string,
  ): Promise<void> {
    const { index } = target;
    const grid = index.audioGrids[rendition.track.number]!;
    const isLast = n + 1 >= segmentCount(index);
    const start = copySegmentStart(index, grid, n);
    const end = isLast
      ? Math.ceil((index.duration * grid.rate) / grid.frame) * grid.frame
      : copySegmentStart(index, grid, n + 1);
    const k = index.segmentStarts[n];
    const from =
      n === 0 || k === undefined
        ? Number.NEGATIVE_INFINITY
        : index.keyframes[k]!.ts;
    const to = isLast
      ? null
      : secondsToTicks(
          index,
          (end + grid.frame) / grid.rate +
            gridPhase(grid) +
            AUDIO_READ_MARGIN_SECONDS,
        );
    const period = roundingPeriod(index, grid);
    const file = `${index.fileName}:${index.fileLength}`;
    const slices = [
      keyframeAudioSlice(
        index,
        n,
        to,
        timeSlice(index, from, to, { tight: true }),
      ),
      timeSlice(index, from, to),
    ];
    let widened = false;

    for (const [attempt, slice] of slices.entries()) {
      const canRetry = attempt < slices.length - 1;
      const temp = tempPathFor(outPath);
      try {
        const result = await this.run(
          target,
          slice,
          audioCopyArgs(rendition, [], temp),
        );
        if (!isComplete(index, slice, result)) {
          this.noteShortRead(slice, file);
          if (canRetry) {
            continue;
          }
          // Only a window read to its end shows the track has no audio left.
          if (!result.readAll) {
            throw boundaryError(n);
          }
        }
        target.signal?.throwIfAborted();

        const output = (await exists(temp))
          ? await readFile(temp)
          : Buffer.alloc(0);
        const fragment = readFragments(output);
        const silence = () =>
          this.copySilence(index, rendition, grid, () =>
            this.firstCopiedPacket(
              { ...target, signal: undefined },
              rendition,
              outPath,
            ),
          );
        const timescale =
          fragment.length > 0
            ? trackTimescale(output)
            : (await silence()).timescale;
        const unit = timescale / grid.rate;
        const offset = TIMELINE_OFFSET_SECONDS * timescale;
        // ffmpeg times TrueHD access units by counting from the first one it
        // keeps, and drops some at the edges of the window. The timestamps of
        // the blocks they came from are the real times.
        const skipped =
          rendition.track.codecId === 'A_TRUEHD'
            ? firstBlockOf(fragment, result.sizes)
            : -1;
        const samples: TimedSample[] = [];
        for (const [i, sample] of fragment.entries()) {
          samples.push({
            ...sample,
            time:
              skipped >= 0
                ? ticksToSeconds(index, result.timestamps[i + skipped]!) *
                  timescale
                : sample.dts - offset,
            length: Math.round(
              packetSamples(rendition.track, sample.data, grid) * unit,
            ),
          });
        }
        const placements = placeCopiedAudio(
          samples,
          {
            frame: Math.round(grid.frame * unit),
            phase: gridPhase(grid) * timescale,
            jitter: (index.timestampScale / 1e9) * timescale + 1,
            period,
          },
          from === Number.NEGATIVE_INFINITY,
          to === null,
          widened,
        );
        if (!placements) {
          // A run's place on the grid needs a full rounding period of it.
          widened = true;
          const extra = secondsToTicks(index, ((period + 1) * grid.frame) / grid.rate);
          slices.push(
            timeSlice(index, from - extra, to === null ? null : to + extra),
          );
          continue;
        }

        const first = start * unit;
        const last = end * unit;
        const out: FragmentSample[] = [];
        let at = first;
        for (const { position, sample } of placements) {
          // Before the segment, colliding with a kept packet, or past the end.
          if (position < at || position + sample.length > last) {
            continue;
          }
          if (position > at) {
            out.push(...(await (await silence()).fill(position - at)));
          }
          out.push({ ...sample, duration: sample.length });
          at = position + sample.length;
        }
        if (at < last) {
          out.push(...(await (await silence()).fill(last - at)));
        }
        target.signal?.throwIfAborted();
        await writeFileAtomic(outPath, writeFragment(first + offset, out));

        return;
      } finally {
        await rm(temp, { force: true });
      }
    }
  }

  // Shared by every segment of the track, so the reference it is modelled on
  // must not be stopped by any single caller's signal.
  private copySilence(
    index: MediaIndex,
    rendition: AudioRendition,
    grid: AudioGrid,
    reference: () => Promise<SilenceReference>,
  ): Promise<CopySilence> {
    const key = `${index.fileName}:${index.fileLength}:${rendition.track.number}`;
    let silence = this.copySilences.get(key);
    if (!silence) {
      silence = this.makeCopySilence(rendition, grid, reference);
      silence.catch(() => {
        this.copySilences.delete(key);
      });
      this.copySilences.set(key, silence);
      while (this.copySilences.size > MAX_REMEMBERED_FILES) {
        this.copySilences.delete(this.copySilences.keys().next().value!);
      }
    }

    return silence;
  }

  // scratch names where its temporary files go.
  private async firstCopiedPacket(
    target: MatroskaTarget,
    rendition: AudioRendition,
    scratch: string,
  ): Promise<SilenceReference> {
    const temp = tempPathFor(scratch);
    let reference: Buffer;
    try {
      await this.run(
        target,
        timeSlice(target.index, Number.NEGATIVE_INFINITY, null),
        audioCopyArgs(rendition, ['-frames:a', '1'], temp),
      );
      reference = await readFile(temp);
    } finally {
      await rm(temp, { force: true });
    }
    const packet = readFragments(reference)[0]?.data;
    if (!packet) {
      throw new Error(
        `Track ${rendition.track.number} has no packet to model silence on`,
      );
    }

    return { packet, timescale: trackTimescale(reference) };
  }

  private async makeCopySilence(
    rendition: AudioRendition,
    grid: AudioGrid,
    reference: () => Promise<SilenceReference>,
  ): Promise<CopySilence> {
    const { packet, timescale } = await reference();
    const unit = timescale / grid.rate;
    const frames = new Map<number, Promise<FragmentSample[]>>();
    const framesOf = (samples: number) => {
      let made = frames.get(samples);
      if (!made) {
        made = this.encodeSilence(rendition, packet, grid, samples);
        made.catch(() => {
          frames.delete(samples);
        });
        frames.set(samples, made);
      }

      return made;
    };

    return {
      timescale,
      fill: async (length) => {
        const out: FragmentSample[] = [];
        let rest = length;
        const sizes = silenceSizes(
          rendition.track,
          grid,
          Math.round(length / unit),
        );
        for (const [i, size] of sizes.entries()) {
          const made = await framesOf(size);
          const frame = made[i % made.length]!;
          const duration = Math.min(rest, Math.round(size * unit));
          out.push({ ...frame, duration });
          rest -= duration;
        }

        return out;
      },
    };
  }

  // The closest silence ffmpeg can encode; a layout the encoder refuses falls
  // back to the next one.
  private async encodeSilence(
    rendition: AudioRendition,
    packet: Buffer,
    grid: AudioGrid,
    samples: number,
  ): Promise<FragmentSample[]> {
    const isTrueHd = rendition.track.codecId === 'A_TRUEHD';
    let failure: unknown;
    for (const input of silenceEncoders(rendition.track, packet, grid, samples)) {
      const chunks: Buffer[] = [];
      const collector = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });
      try {
        await this.ffmpeg.run({
          args: [
            ...input,
            '-frames:a',
            String(isTrueHd ? TRUEHD_SILENCE_FRAMES : SILENCE_FRAMES),
            ...fmp4OutputArgs(COPIED_AUDIO_MOVFLAGS),
          ],
          output: collector,
          timeoutMs: this.options.timeoutMs,
        });
      } catch (err) {
        failure = err;
        continue;
      }
      const made = readFragments(Buffer.concat(chunks));
      if (made.length === 0) {
        continue;
      }

      // The first AAC packet carries the encoder name, not silence alone.
      return isTrueHd ? made : [made[Math.min(4, made.length - 1)]!];
    }
    throw new Error(
      `No silence could be encoded for track ${rendition.track.number}: ${errorMessage(failure)}`,
    );
  }

  // Cues that began in an earlier segment and are still on screen when
  // segment n starts. Each is the source block itself, so it converts to the
  // same cue line as in the segment it began in.
  private async carriedCues(
    target: MatroskaTarget,
    n: number,
  ): Promise<Buffer[]> {
    const { index, source, rendition } = target;
    const k = index.segmentStarts[n];
    const keyframe =
      n === 0 || k === undefined ? undefined : index.keyframes[k];
    const cues = index.subtitleCues[rendition.track.number];
    if (!keyframe || !cues) {
      return [];
    }
    const active: SubtitleCue[] = [];
    for (const cue of cues) {
      if (cue.ts >= keyframe.ts) {
        break;
      }
      // A block stored past the keyframe is in the segment's own slice. In the
      // keyframe's cluster that is only ruled out by both offsets.
      const before =
        cue.cluster < keyframe.cluster ||
        (cue.cluster === keyframe.cluster &&
          cue.rel !== undefined &&
          keyframe.rel !== undefined &&
          cue.rel < keyframe.rel);
      if (before && cue.ts + cue.duration > keyframe.ts) {
        active.push(cue);
      }
    }

    const found = await Promise.all(
      active.map(async (cue) => {
        try {
          const cluster = await blockCluster(
            source,
            { cluster: cue.cluster, rel: cue.rel, end: index.mediaEnd },
            rendition.track.number,
            cue.ts,
          );
          if (!cluster) {
            this.options.logger.debug('Subtitle block is not where Cues put it', {
              file: index.fileName,
              ts: cue.ts,
            });
          }

          return cluster;
        } catch (err) {
          this.options.logger.debug('Subtitle block could not be read', {
            file: index.fileName,
            ts: cue.ts,
            error: errorMessage(err),
          });
        }
      }),
    );

    return found.filter((cluster) => cluster !== undefined);
  }

  private async run(
    target: MatroskaTarget,
    slice: SliceTarget,
    args: string[],
    output?: Writable | [Transform, Writable],
    carried?: Buffer[],
  ): Promise<SliceRun> {
    const { index, source, rendition, signal } = target;
    const readable = source.stream(slice.readStart, slice.readEnd);
    let bytesRead = 0;
    async function* counted(): AsyncGenerator<Buffer> {
      for await (const chunk of readable as AsyncIterable<Buffer>) {
        bytesRead += chunk.length;
        yield chunk;
      }
    }
    const { stream, result } = sliceMatroska(counted(), {
      header: trackHeader(index, rendition),
      track: rendition.track.number,
      videoTrack: index.videoTrack,
      range: slice.range,
      carried,
    });
    const finished = (): SliceRun => ({
      ...result,
      readAll: bytesRead >= slice.readEnd - slice.readStart,
    });

    try {
      await this.ffmpeg.run({
        args,
        input: stream,
        output,
        signal,
        timeoutMs: this.options.timeoutMs,
      });

      return finished();
    } catch (err) {
      // ffmpeg fails on an audio track whose window held none of its blocks.
      // Read to the end, that window is a gap the caller fills with silence.
      // A short read, an abort or a block that failed still throws.
      const run = finished();
      if (
        rendition.type === 'audio' &&
        run.blocks === 0 &&
        (run.reachedEnd || run.readAll) &&
        !signal?.aborted
      ) {
        return run;
      }
      throw err;
    } finally {
      readable.destroy();
    }
  }
}

function plan(
  index: MatroskaIndex,
  rendition: VideoRendition | SubtitleRendition,
  n: number,
): Plan {
  const keyframeSlices = [
    keyframeSlice(index, n, true),
    keyframeSlice(index, n, false),
  ];

  switch (rendition.type) {
    case 'video':
      return { slices: keyframeSlices, args: copyArgs(rendition) };
    case 'subtitle':
      return {
        slices: keyframeSlices,
        args: [...INPUT_ARGS, ...WEBVTT_OUTPUT_ARGS],
      };
  }
}

function trackHeader(index: MatroskaIndex, rendition: Rendition): Buffer {
  return buildTrackHeader(
    Buffer.from(index.ebmlHeader, 'base64'),
    Buffer.from(index.info, 'base64'),
    Buffer.from(rendition.track.entry, 'base64'),
  );
}

export function initNeedsPacket(
  rendition: Rendition,
): rendition is AudioRendition {
  return (
    rendition.type === 'audio' &&
    (rendition.transcode ||
      INIT_FROM_PACKET_AUDIO.test(rendition.track.codecId))
  );
}

function copyArgs(rendition: VideoRendition | AudioRendition): string[] {
  if (rendition.type === 'audio') {
    return audioCopyArgs(rendition);
  }
  // HEVC in fMP4 must carry the hvc1 tag; players reject hev1 here.
  const tag = rendition.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [];

  return [...INPUT_ARGS, '-c', 'copy', ...tag, ...VIDEO_OUTPUT_ARGS];
}

// -map_metadata -1 drops the source language with the rest, so the init
// segment states it again, ahead of the output that ends the arguments. The
// MP4 language field holds an ISO 639-2 code only.
function withLanguage(args: string[], language: string): string[] {
  if (!/^[a-z]{3}$/u.test(language)) {
    return args;
  }

  return [
    ...args.slice(0, -1),
    '-metadata:s:0',
    `language=${language}`,
    args.at(-1)!,
  ];
}

function fieldBox({ track }: VideoRendition): Buffer | undefined {
  const { interlaced, fieldOrder = 0 } = track;
  if (interlaced === 1) {
    return Buffer.from([2, FIELD_ORDERS.has(fieldOrder) ? fieldOrder : 0]);
  }

  return interlaced === 2 ? Buffer.from([1, 0]) : undefined;
}

function audioCopyArgs(
  rendition: AudioRendition,
  extraArgs: string[] = [],
  output?: string,
): string[] {
  // ffmpeg still treats TrueHD in MP4 as experimental.
  const strict =
    rendition.track.codecId === 'A_TRUEHD' ? ['-strict', '-2'] : [];

  return [
    ...INPUT_ARGS,
    ...extraArgs,
    '-c',
    'copy',
    ...strict,
    ...fmp4OutputArgs(COPIED_AUDIO_MOVFLAGS, output),
  ];
}

function aacOutput(
  rendition: AudioRendition,
  coder: AacCoder,
): { rate: number; args: string[] } {
  return {
    rate: aacSampleRate(rendition.track),
    args: [
      '-c:a',
      'aac',
      '-aac_coder',
      coder,
      '-b:a',
      aacBitrate(aacChannels(rendition.track)),
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

function silenceArgs(
  rendition: AudioRendition,
  layout: string,
  coder: AacCoder,
): string[] {
  const { rate, args } = aacOutput(rendition, coder);

  return [
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=${rate}:cl=${layout}`,
    '-t',
    '0.1',
    '-map',
    '0:0',
    ...args,
    ...FMP4_OUTPUT_ARGS,
  ];
}

function aacPlan(
  index: MatroskaIndex,
  rendition: AudioRendition,
  n: number,
  fromKeyframe: boolean,
  layout: AacLayout,
  coder: AacCoder,
): Plan {
  const encode = aacEncode(index, rendition, n, layout, coder, INPUT_ARGS);
  const from = secondsToTicks(index, encode.from);
  const to = encode.to === null ? null : secondsToTicks(index, encode.to);
  const tight = timeSlice(index, from, to, { tight: true });

  return {
    slices: [
      ...(fromKeyframe ? [keyframeAudioSlice(index, n, to, tight)] : []),
      tight,
      timeSlice(index, from, to),
    ],
    args: encode.args,
    silence: encode.silence,
  };
}

function aacEncode(
  index: MediaIndex,
  rendition: AudioRendition,
  n: number,
  { layout, filter }: AacLayout,
  coder: AacCoder,
  inputArgs: string[],
): AacEncode {
  const { rate, args: outputArgs } = aacOutput(rendition, coder);
  const padding = AUDIO_PAD_FRAMES * AAC_FRAME_SAMPLES;

  const isLast = n + 1 >= segmentCount(index);
  const start = aacSegmentStart(index, rate, n);
  // The last segment runs to the playlist's end, rounded up to a whole frame.
  const end = isLast
    ? Math.ceil((index.duration * rate) / AAC_FRAME_SAMPLES) *
      AAC_FRAME_SAMPLES
    : aacSegmentStart(index, rate, n + 1);
  const encodeFrom = Math.max(0, start - padding);
  const encodeTo = end + padding;

  // Resampling comes first: aresample reads first_pts in input samples, which
  // drift from the output grid when it converts the rate in the same pass.
  // Holes become silence and the pad fills to the end of the encode range.
  const filters = [
    filter,
    `aresample=${rate}`,
    `aresample=async=1:min_hard_comp=${AUDIO_SYNC_TOLERANCE_SECONDS}:first_pts=${encodeFrom}`,
    'apad',
    `atrim=start_pts=${encodeFrom}:end_pts=${encodeTo}`,
  ];

  // Frames outside the segment were encoded for context. The bitstream filter
  // drops them by presentation timestamp.
  const outputTail = [
    ...outputArgs,
    '-bsf:a',
    `noise=drop=lt(pts\\,${start})+gte(pts\\,${end})`,
    ...FMP4_OUTPUT_ARGS,
  ];

  return {
    from: encodeFrom / rate - AUDIO_READ_MARGIN_SECONDS,
    to: isLast ? null : encodeTo / rate + AUDIO_READ_MARGIN_SECONDS,
    args: [...inputArgs, '-af', filters.join(','), ...outputTail],
    silence: [
      '-f',
      'lavfi',
      '-i',
      `anullsrc=r=${rate}:cl=${layout}`,
      '-map',
      '0:0',
      '-af',
      `atrim=end_sample=${encodeTo - encodeFrom},asetpts=N+${encodeFrom}`,
      ...outputTail,
    ],
  };
}

function keyframeAudioSlice(
  index: MatroskaIndex,
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

/**
 * Places copied packets on the grid, run by run. A run is a stretch of
 * packets that follow each other without a gap. Its place comes from the span
 * of times its packets allow; when that span crosses a grid boundary, the
 * midpoint over a full rounding period decides, which every window holding
 * such a period computes alike. Without one, and with the run still open at
 * an edge of the window, the answer is undefined unless force is set.
 */
function placeCopiedAudio(
  samples: TimedSample[],
  lattice: Lattice,
  closedStart: boolean,
  closedEnd: boolean,
  force: boolean,
): Placement[] | undefined {
  const placements: Placement[] = [];
  const slot = (time: number) =>
    Math.round((time - lattice.phase) / lattice.frame);
  let first = 0;
  for (let i = 1; i <= samples.length; i++) {
    const prev = samples[i - 1]!;
    const next = samples[i];
    if (
      next &&
      Math.abs(next.time - prev.time - prev.length) <= lattice.jitter
    ) {
      continue;
    }

    let latest = Number.NEGATIVE_INFINITY;
    let earliest = Number.POSITIVE_INFINITY;
    let offset = 0;
    for (let j = first; j < i; j++) {
      const anchor = samples[j]!.time - offset;
      latest = Math.max(latest, anchor);
      earliest = Math.min(earliest, anchor);
      offset += samples[j]!.length;
    }
    let k = slot(latest - lattice.jitter);
    if (k !== slot(earliest + lattice.jitter)) {
      const whole = (first > 0 || closedStart) && (next !== undefined || closedEnd);
      if (!force && !whole && i - first < lattice.period) {
        return undefined;
      }
      k = slot((latest + earliest) / 2);
    }

    let position = k * lattice.frame;
    for (let j = first; j < i; j++) {
      placements.push({ position, sample: samples[j]! });
      position += samples[j]!.length;
    }
    first = i;
  }

  return placements.sort((a, b) => a.position - b.position);
}

// The index of the block the first sample was cut from: the first place
// where the block sizes run as the sample sizes do. -1 when none matches.
function firstBlockOf(samples: FragmentSample[], sizes: number[]): number {
  const checked = Math.min(samples.length, 16);
  for (let block = 0; block + samples.length <= sizes.length; block++) {
    let i = 0;
    while (i < checked && sizes[block + i] === samples[i]!.data.length) {
      i++;
    }
    if (i === checked) {
      return block;
    }
  }

  return -1;
}

// Matroska rounds each timestamp to a tick, and the rounding error of a
// track's packets repeats every this many frames.
function roundingPeriod(index: MatroskaIndex, grid: AudioGrid): number {
  const ticks = grid.rate * index.timestampScale;
  let a = grid.frame * 1e9;
  let b = ticks;
  while (b > 0) {
    [a, b] = [b, a % b];
  }

  return ticks / a;
}

// A run is complete when the wanted range was found in the bytes read.
// ffmpeg exits zero on a short read too.
function isComplete(
  index: MatroskaIndex,
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

// Every frame lasts until the next one is presented and the last one until
// the next segment starts, so the video has no holes. Decoding starts at the
// segment's playlist start, whatever the frame order. A failed timing
// correction keeps ffmpeg's timestamps rather than failing the segment.
async function retimeSegment(
  file: string,
  init: Buffer,
  index: MatroskaIndex,
  n: number,
  timestamps: number[],
  logger: Logger,
): Promise<void> {
  const output = await readFile(file);
  let fragment: Buffer;
  try {
    const scale = trackTimescale(init);
    const time = (seconds: number) =>
      Math.round((seconds + TIMELINE_OFFSET_SECONDS) * scale);
    const samples = readFragments(output);
    if (samples.length !== timestamps.length) {
      throw new Error(
        `Fragment has ${samples.length} samples but ${timestamps.length} timestamps`,
      );
    }
    const start = time(segmentStart(index, n));
    const end = time(
      n + 1 < segmentCount(index) ? segmentStart(index, n + 1) : index.duration,
    );
    const pts: number[] = [];
    const order: number[] = [];
    for (const [i, ticks] of timestamps.entries()) {
      pts.push(time(ticksToSeconds(index, ticks)));
      order.push(i);
    }
    order.sort((a, b) => pts[a]! - pts[b]!);
    // The first frame is shown from the start of the playlist.
    const first = order[0];
    if (n === 0 && first !== undefined && pts[first]! > start) {
      pts[first] = start;
    }
    for (const [k, i] of order.entries()) {
      const next = order[k + 1];
      const until = next === undefined ? end : pts[next]!;
      // A frame at or past its successor keeps ffmpeg's duration.
      if (until > pts[i]!) {
        samples[i]!.duration = until - pts[i]!;
      }
    }
    let dts = start;
    for (const [i, sample] of samples.entries()) {
      sample.compositionOffset = pts[i]! - dts;
      dts += sample.duration;
    }
    fragment = writeFragment(start, samples);
  } catch (err) {
    logger.warn('Segment keeps ffmpeg timestamps', {
      file,
      error: errorMessage(err),
    });

    return;
  }
  await writeFile(file, fragment);
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
