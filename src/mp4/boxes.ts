/** The MP4 or QuickTime file is malformed. */
export class Mp4Error extends Error {
  override name = 'Mp4Error';
}

/** A box inside a buffer: start of its header, start of its payload, end. */
export type Mp4Box = {
  type: string;
  start: number;
  body: number;
  end: number;
};

/**
 * The box whose header starts at pos, or undefined when fewer header bytes
 * than it needs remain before limit. A size of zero runs the box to limit.
 */
export function readBoxHeader(
  buf: Buffer,
  pos: number,
  limit = buf.length,
): Mp4Box | undefined {
  if (pos + 8 > limit) {
    return undefined;
  }
  const size32 = buf.readUInt32BE(pos);
  const type = buf.toString('latin1', pos + 4, pos + 8);
  if (size32 === 1 && pos + 16 > limit) {
    return undefined;
  }
  const body = pos + (size32 === 1 ? 16 : 8);
  const size =
    size32 === 1
      ? Number(buf.readBigUInt64BE(pos + 8))
      : size32 === 0
        ? limit - pos
        : size32;
  if (size < body - pos) {
    throw new Mp4Error(`MP4 box ${type} has an invalid size`);
  }

  return { type, start: pos, body, end: pos + size };
}

export function* childBoxes(
  buf: Buffer,
  start: number,
  end: number,
): Generator<Mp4Box> {
  let pos = start;
  while (pos + 8 <= end) {
    const box = readBoxHeader(buf, pos, end);
    if (!box) {
      return;
    }
    if (box.end > end) {
      throw new Mp4Error(`MP4 box ${box.type} runs past its parent`);
    }
    yield box;
    pos = box.end;
  }
}

export function children(buf: Buffer, parent: Mp4Box): Generator<Mp4Box> {
  return childBoxes(buf, parent.body, parent.end);
}

export function findChild(
  buf: Buffer,
  parent: Mp4Box,
  type: string,
): Mp4Box | undefined {
  for (const box of children(buf, parent)) {
    if (box.type === type) {
      return box;
    }
  }

  return undefined;
}

export function findPath(
  buf: Buffer,
  parent: Mp4Box,
  path: string[],
): Mp4Box | undefined {
  let box: Mp4Box | undefined = parent;
  for (const type of path) {
    box = box && findChild(buf, box, type);
  }

  return box;
}

export function payload(buf: Buffer, box: Mp4Box): Buffer {
  return buf.subarray(box.body, box.end);
}
