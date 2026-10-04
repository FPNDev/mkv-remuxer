import { readRange, type ByteSource } from '../io/byte-source.js';
import { parseCues, type CuePoint } from './cues.js';
import {
  childElements,
  MatroskaError,
  readElementHeader,
  readFloat,
  readString,
  readUint,
  UNKNOWN_SIZE,
  type EbmlElement,
  type ElementHeader,
} from './ebml.js';
import { Id } from './ids.js';
import { parseTracks, type MkvTrack } from './tracks.js';

export type MatroskaLayout = {
  docType: string;
  ebmlHeader: Buffer;
  info: Buffer;
  timestampScale: number;
  durationTicks: number | undefined;
  firstClusterOffset: number;
  mediaEnd: number;
  tracks: MkvTrack[];
  cues: CuePoint[];
};

type RawElement = {
  header: ElementHeader;
  data: Buffer;
};

// Header walking touches many small elements, so every read pulls at least
// this much and later elements come out of the same block.
const READ_AHEAD = 256 * 1024;

const EARLY_MEDIA_BYTES = 16 * 1024 * 1024;

class CachedReader {
  private readonly blocks: { start: number; data: Buffer }[] = [];

  constructor(private readonly source: ByteSource) {}

  async read(start: number, end: number): Promise<Buffer> {
    end = Math.min(end, this.source.length);
    for (const block of this.blocks) {
      if (start >= block.start && end <= block.start + block.data.length) {
        return block.data.subarray(start - block.start, end - block.start);
      }
    }

    const fetchEnd = Math.min(
      this.source.length,
      Math.max(end, start + (this.source.minReadBytes ?? READ_AHEAD)),
    );
    const data = await readRange(this.source, start, fetchEnd);
    if (data.length < end - start) {
      throw new MatroskaError(`Unexpected end of file at byte ${start}`);
    }
    this.blocks.push({ start, data });
    return data.subarray(0, end - start);
  }

  async header(pos: number): Promise<ElementHeader> {
    // 12 bytes covers the widest header: a 4-byte ID and an 8-byte size.
    const header = readElementHeader(await this.read(pos, pos + 12), 0);
    if (!header) {
      throw new MatroskaError(`Truncated element at byte ${pos}`);
    }
    return header;
  }

  async element(
    pos: number,
    expectedId?: number,
  ): Promise<RawElement | undefined> {
    const header = await this.header(pos);
    if (expectedId !== undefined && header.id !== expectedId) {
      return undefined;
    }
    if (header.size === UNKNOWN_SIZE) {
      throw new MatroskaError(`Unsized element at byte ${pos}`);
    }
    const data = await this.read(pos, pos + header.headerLength + header.size);
    return { header, data };
  }
}

const asElement = ({ header, data }: RawElement): EbmlElement => ({
  id: header.id,
  start: 0,
  dataStart: header.headerLength,
  dataEnd: data.length,
});

/**
 * Reads everything before the first cluster: EBML header, Info, Tracks and the
 * Cues index. Throws MatroskaError when the file has no Cues, since seeking
 * then needs the whole download.
 */
export async function readMatroskaLayout(
  source: ByteSource,
): Promise<MatroskaLayout> {
  const reader = new CachedReader(source);

  const ebml = await reader.element(0, Id.EBML);
  if (!ebml) {
    throw new MatroskaError('Not a Matroska file');
  }

  let docType = 'matroska';
  for (const el of childElements(ebml.data, ebml.header.headerLength)) {
    if (el.id === Id.DocType) {
      docType = readString(ebml.data, el);
    }
  }
  if (docType !== 'matroska' && docType !== 'webm') {
    throw new MatroskaError(`Unsupported DocType "${docType}"`);
  }

  let pos = ebml.data.length;
  let segment = await reader.header(pos);
  // Muxers pad between the EBML header and Segment with Void.
  while (segment.id === Id.Void && segment.size !== UNKNOWN_SIZE) {
    pos += segment.headerLength + segment.size;
    segment = await reader.header(pos);
  }
  if (segment.id !== Id.Segment) {
    throw new MatroskaError('Segment element not found');
  }

  const segmentStart = pos + segment.headerLength;
  // A Segment written by a live muxer has no size: it runs to end of file.
  const segmentEnd =
    segment.size === UNKNOWN_SIZE
      ? source.length
      : Math.min(source.length, segmentStart + segment.size);

  const seeks = new Map<number, number[]>();
  const loadedSeekHeads = new Set<number>();
  const loadSeekHead = async (at: number) => {
    if (loadedSeekHeads.has(at)) {
      return;
    }
    loadedSeekHeads.add(at);

    const head = await reader.element(at, Id.SeekHead);
    if (!head) {
      return;
    }
    for (const seek of childElements(head.data, head.header.headerLength)) {
      if (seek.id !== Id.Seek) {
        continue;
      }
      let id: number | undefined;
      let position: number | undefined;
      for (const el of childElements(head.data, seek.dataStart, seek.dataEnd)) {
        if (el.id === Id.SeekID) {
          id = readUint(head.data, el);
        }
        if (el.id === Id.SeekPosition) {
          position = readUint(head.data, el);
        }
      }
      if (id !== undefined && position !== undefined) {
        // SeekPosition is relative to the Segment data start; the map
        // keeps absolute offsets.
        seeks.set(id, [...(seeks.get(id) ?? []), segmentStart + position]);
      }
    }
  };

  let info: RawElement | undefined;
  let tracks: RawElement | undefined;
  let cues: RawElement | undefined;
  let firstCluster: number | undefined;

  pos = segmentStart;
  while (pos < segmentEnd) {
    const header = await reader.header(pos);
    if (header.id === Id.Cluster) {
      firstCluster = pos;
      break;
    }
    if (header.size === UNKNOWN_SIZE) {
      throw new MatroskaError(`Unsized top-level element at byte ${pos}`);
    }

    if (header.id === Id.SeekHead) {
      await loadSeekHead(pos);
    } else if (header.id === Id.Info) {
      info = await reader.element(pos);
    } else if (header.id === Id.Tracks) {
      tracks = await reader.element(pos);
    } else if (header.id === Id.Cues) {
      cues = await reader.element(pos);
    }

    pos += header.headerLength + header.size;
  }
  if (firstCluster === undefined) {
    throw new MatroskaError('File has no clusters');
  }
  source.prefetch?.(firstCluster, firstCluster + EARLY_MEDIA_BYTES);

  // A SeekHead can point at another SeekHead, usually one stored at the end of
  // the file next to the Cues. loadSeekHead ignores repeats, so cycles end.
  for (let i = 0; i < (seeks.get(Id.SeekHead)?.length ?? 0); i++) {
    await loadSeekHead(seeks.get(Id.SeekHead)![i]!);
  }

  const bySeek = async (id: number) => {
    for (const at of seeks.get(id) ?? []) {
      const element = await reader.element(at, id);
      if (element) {
        return element;
      }
    }
  };

  info ??= await bySeek(Id.Info);
  tracks ??= await bySeek(Id.Tracks);
  cues ??= await bySeek(Id.Cues);

  if (!info) {
    throw new MatroskaError('Info element not found');
  }
  if (!tracks) {
    throw new MatroskaError('Tracks element not found');
  }
  if (!cues) {
    throw new MatroskaError(
      'File has no Cues index, so it cannot be streamed without a full download',
    );
  }

  // Nanoseconds per tick. The Matroska default of 1,000,000 makes ticks
  // milliseconds.
  let timestampScale = 1_000_000;
  let durationTicks: number | undefined;
  for (const el of childElements(info.data, info.header.headerLength)) {
    if (el.id === Id.TimestampScale) {
      timestampScale = readUint(info.data, el);
    }
    if (el.id === Id.Duration) {
      durationTicks = readFloat(info.data, el);
    }
  }

  // Clusters end where the first element indexed after them begins. Cues, Tags
  // and Attachments sit at either end of the file depending on the muxer.
  let mediaEnd = segmentEnd;
  for (const id of [
    Id.Cues,
    Id.Tags,
    Id.Attachments,
    Id.Chapters,
    Id.SeekHead,
  ]) {
    for (const at of seeks.get(id) ?? []) {
      if (at > firstCluster && at < mediaEnd) {
        mediaEnd = at;
      }
    }
  }

  return {
    docType,
    ebmlHeader: Buffer.from(ebml.data),
    info: Buffer.from(info.data),
    timestampScale,
    durationTicks,
    firstClusterOffset: firstCluster,
    mediaEnd,
    tracks: parseTracks(tracks.data, asElement(tracks)),
    // Rebase cue positions to absolute file offsets for the byte source.
    cues: parseCues(cues.data, asElement(cues)).map((cue) => ({
      time: cue.time,
      track: cue.track,
      clusterPosition: segmentStart + cue.clusterPosition,
      relativePosition: cue.relativePosition,
    })),
  };
}
