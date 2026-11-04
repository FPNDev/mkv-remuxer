import { open } from 'node:fs/promises';
import path from 'node:path';

import { readRange, type ByteSource } from '../io/byte-source.js';
import { writeFileAtomic } from '../util/fs.js';

/**
 * The samples of one track in decode order, one entry per sample in each
 * column. Times are in the track timescale, dts already moved by the track's
 * edit list.
 */
export type SampleColumns = {
  offsets: number[];
  dts: number[];
  durations: number[];
  sizes: number[];
  ctos: number[];
  sync: boolean[];
};

export type SampleRecord = {
  offset: number;
  dts: number;
  duration: number;
  size: number;
  cto: number;
  sync: boolean;
};

/** One byte range and the records whose bytes it holds. */
type ReadRun = {
  start: number;
  end: number;
  members: number[];
};

// offset f64, dts f64, duration u32, size u32, composition offset i32, sync
// u8. Fixed width, so sample i sits at i * RECORD_BYTES.
const RECORD_BYTES = 29;
// Samples of a track this close together are read as one range, the bytes of
// the other tracks between them included.
const READ_GAP_BYTES = 256 * 1024;

export function emptyColumns(): SampleColumns {
  return {
    offsets: [],
    dts: [],
    durations: [],
    sizes: [],
    ctos: [],
    sync: [],
  };
}

export function sampleTableFile(dir: string, track: number): string {
  return path.join(dir, `${track}.bin`);
}

export function writeSampleTable(
  file: string,
  samples: SampleColumns,
): Promise<void> {
  const buf = Buffer.alloc(samples.offsets.length * RECORD_BYTES);
  for (const [i, offset] of samples.offsets.entries()) {
    const at = i * RECORD_BYTES;
    buf.writeDoubleLE(offset, at);
    buf.writeDoubleLE(samples.dts[i]!, at + 8);
    buf.writeUInt32LE(samples.durations[i]!, at + 16);
    buf.writeUInt32LE(samples.sizes[i]!, at + 20);
    buf.writeInt32LE(samples.ctos[i]!, at + 24);
    buf[at + 28] = samples.sync[i] ? 1 : 0;
  }

  return writeFileAtomic(file, buf);
}

/** Samples from `from` up to `to`, exclusive, cut to the samples there are. */
export async function readSampleTable(
  file: string,
  from: number,
  to: number,
): Promise<SampleRecord[]> {
  const start = Math.max(0, from);
  const buf = Buffer.alloc(Math.max(0, to - start) * RECORD_BYTES);
  const handle = await open(file, 'r');
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buf, 0, buf.length, start * RECORD_BYTES));
  } finally {
    await handle.close();
  }

  const records: SampleRecord[] = [];
  for (let at = 0; at + RECORD_BYTES <= bytesRead; at += RECORD_BYTES) {
    records.push({
      offset: buf.readDoubleLE(at),
      dts: buf.readDoubleLE(at + 8),
      duration: buf.readUInt32LE(at + 16),
      size: buf.readUInt32LE(at + 20),
      cto: buf.readInt32LE(at + 24),
      sync: buf[at + 28] === 1,
    });
  }

  return records;
}

/** The bytes of each record, read in as few ranges as lie close together. */
export async function readSampleData(
  source: ByteSource,
  records: SampleRecord[],
): Promise<Buffer[]> {
  const runs: ReadRun[] = [];
  for (const [i, record] of records.entries()) {
    const run = runs.at(-1);
    if (
      run &&
      record.offset >= run.end &&
      record.offset - run.end <= READ_GAP_BYTES
    ) {
      run.end = record.offset + record.size;
      run.members.push(i);
    } else {
      runs.push({
        start: record.offset,
        end: record.offset + record.size,
        members: [i],
      });
    }
  }

  const data: Buffer[] = [];
  await Promise.all(
    runs.map(async (run) => {
      const bytes = await readRange(source, run.start, run.end);
      if (bytes.length < run.end - run.start) {
        throw new Error(
          `Sample data at ${run.start} ended after ${bytes.length} bytes`,
        );
      }
      for (const i of run.members) {
        const { offset, size } = records[i]!;
        data[i] = bytes.subarray(offset - run.start, offset - run.start + size);
      }
    }),
  );

  return data;
}
