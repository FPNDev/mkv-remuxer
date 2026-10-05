export class MatroskaError extends Error {
  override name = 'MatroskaError';
}

export const UNKNOWN_SIZE = -1;

// All-ones 8-byte vint: the size a muxer writes when it does not yet know the
// length. Used for Segment and Cluster in streamed output.
export const UNKNOWN_SIZE_VINT = Buffer.from([
  0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

export type ElementHeader = {
  id: number;
  size: number;
  headerLength: number;
};

export type EbmlElement = {
  id: number;
  start: number;
  dataStart: number;
  dataEnd: number;
};

// Length comes from the leading zeros: 1xxxxxxx is one byte, 01xxxxxx two, up
// to eight. A zero byte is not a valid vint start.
export function vintLength(firstByte: number): number {
  return firstByte === 0 ? 0 : Math.clz32(firstByte) - 23;
}

/**
 * Returns null when buf ends mid-header, so the caller can read more bytes.
 * Throws only on bytes that cannot be a header at all.
 */
export function readElementHeader(
  buf: Uint8Array,
  pos: number,
): ElementHeader | null {
  if (pos >= buf.length) {
    return null;
  }

  const idLength = vintLength(buf[pos]!);
  if (idLength === 0 || idLength > 4) {
    throw new MatroskaError(`Invalid EBML element ID at byte ${pos}`);
  }

  const sizePos = pos + idLength;
  if (sizePos >= buf.length) {
    return null;
  }

  const sizeLength = vintLength(buf[sizePos]!);
  if (sizeLength === 0) {
    throw new MatroskaError(`Invalid EBML element size at byte ${sizePos}`);
  }
  if (sizePos + sizeLength > buf.length) {
    return null;
  }

  let id = 0;
  for (let i = 0; i < idLength; i++) {
    id = id * 256 + buf[pos + i]!;
  }

  const mask = 0xff >> sizeLength;
  let size = buf[sizePos]! & mask;
  let unknown = size === mask;
  for (let i = 1; i < sizeLength; i++) {
    const byte = buf[sizePos + i]!;
    size = size * 256 + byte;
    unknown &&= byte === 0xff;
  }

  return {
    id,
    size: unknown ? UNKNOWN_SIZE : size,
    headerLength: idLength + sizeLength,
  };
}

export function readVint(
  buf: Uint8Array,
  pos: number,
): { value: number; length: number } {
  const length = vintLength(buf[pos] ?? 0);
  if (length === 0 || pos + length > buf.length) {
    throw new MatroskaError(`Invalid vint at byte ${pos}`);
  }

  let value = buf[pos]! & (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i]!;
  }
  return { value, length };
}

export function* childElements(
  buf: Uint8Array,
  start = 0,
  end = buf.length,
): Generator<EbmlElement> {
  const view = buf.subarray(0, end);
  let pos = start;

  while (pos < end) {
    const header = readElementHeader(view, pos);
    if (!header || header.size === UNKNOWN_SIZE) {
      throw new MatroskaError(`Truncated or unsized element at byte ${pos}`);
    }

    const dataStart = pos + header.headerLength;
    const dataEnd = dataStart + header.size;
    if (dataEnd > end) {
      throw new MatroskaError(`Element at byte ${pos} overflows its parent`);
    }

    yield { id: header.id, start: pos, dataStart, dataEnd };
    pos = dataEnd;
  }
}

export function readUint(buf: Uint8Array, el: EbmlElement): number {
  let value = 0;
  for (let i = el.dataStart; i < el.dataEnd; i++) {
    value = value * 256 + buf[i]!;
  }
  return value;
}

// TrackUID is 64 bits, past what readUint's float math keeps exact, so it
// stays a decimal string.
export function readBigUint(buf: Uint8Array, el: EbmlElement): string {
  let value = 0n;
  for (let i = el.dataStart; i < el.dataEnd; i++) {
    value = (value << 8n) | BigInt(buf[i]!);
  }
  return value.toString();
}

export function readFloat(buf: Uint8Array, el: EbmlElement): number {
  const length = el.dataEnd - el.dataStart;
  const view = new DataView(buf.buffer, buf.byteOffset + el.dataStart, length);
  switch (length) {
    case 0:
      return 0;
    case 4:
      return view.getFloat32(0);
    case 8:
      return view.getFloat64(0);
    default:
      throw new MatroskaError(`Invalid float size ${length}`);
  }
}

// EBML strings may be zero-padded to keep a rewritten element the same size.
export function readString(buf: Uint8Array, el: EbmlElement): string {
  return Buffer.from(buf.subarray(el.dataStart, el.dataEnd))
    .toString('utf8')
    .replace(/\0+$/u, '');
}

export function readBytes(buf: Uint8Array, el: EbmlElement): Buffer {
  return Buffer.from(buf.subarray(el.dataStart, el.dataEnd));
}

export function encodeId(id: number): Buffer {
  const length = id >= 0x1000000 ? 4 : id >= 0x10000 ? 3 : id >= 0x100 ? 2 : 1;
  const out = Buffer.alloc(length);
  out.writeUIntBE(id, 0, length);
  return out;
}

function encodeSize(size: number): Buffer {
  let length = 1;
  // The all-ones value of each width is reserved for unknown size, so a size
  // that would hit it needs one more byte.
  while (length < 8 && size >= 2 ** (7 * length) - 1) {
    length++;
  }

  const out = Buffer.alloc(length);
  let rest = size;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] = out[0]! | (0x80 >> (length - 1));
  return out;
}

export function encodeUint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return Buffer.from(bytes);
}

export function encodeElement(id: number, payload: Uint8Array): Buffer {
  return Buffer.concat([encodeId(id), encodeSize(payload.length), payload]);
}
