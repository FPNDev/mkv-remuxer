import type { MkvTrack } from '../matroska/tracks.js';

const UNSPECIFIED = 2;
const SPS_NAL_TYPE = 33;

class BitReader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.position >> 3];
      if (byte === undefined) {
        throw new RangeError('SPS ends early');
      }
      value = value * 2 + ((byte >> (7 - (this.position & 7))) & 1);
      this.position++;
    }
    return value;
  }

  expGolomb(): number {
    let zeros = 0;
    while (this.bits(1) === 0) {
      zeros++;
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }
}

export function hevcTransferCharacteristics(track: MkvTrack): number {
  const { transferCharacteristics, codecPrivate } = track;
  if (
    transferCharacteristics !== undefined &&
    transferCharacteristics !== UNSPECIFIED
  ) {
    return transferCharacteristics;
  }

  if (!codecPrivate) {
    return UNSPECIFIED;
  }

  try {
    const sps = firstSps(Buffer.from(codecPrivate, 'base64'));

    return sps ? spsTransferCharacteristics(sps) : UNSPECIFIED;
  } catch (err) {
    if (err instanceof RangeError) {
      return UNSPECIFIED;
    }
    throw err;
  }
}

function firstSps(hvcC: Buffer): Buffer | undefined {
  const arrays = hvcC.readUInt8(22);
  let offset = 23;
  for (let i = 0; i < arrays; i++) {
    const nalType = hvcC.readUInt8(offset) & 0x3f;
    const nalCount = hvcC.readUInt16BE(offset + 1);
    offset += 3;
    for (let j = 0; j < nalCount; j++) {
      const length = hvcC.readUInt16BE(offset);
      offset += 2;
      if (nalType === SPS_NAL_TYPE) {
        return hvcC.subarray(offset, offset + length);
      }
      offset += length;
    }
  }
  return undefined;
}

function spsTransferCharacteristics(sps: Buffer): number {
  const payload: number[] = [];
  let zeros = 0;
  for (const byte of sps.subarray(2)) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    payload.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  const r = new BitReader(Uint8Array.from(payload));

  r.bits(4);
  const maxSubLayersMinus1 = r.bits(3);
  r.bits(1);

  r.bits(96);
  let subLayerBits = maxSubLayersMinus1 > 0 ? 2 * (8 - maxSubLayersMinus1) : 0;
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subLayerBits += r.bits(1) * 88 + r.bits(1) * 8;
  }
  r.bits(subLayerBits);

  r.expGolomb();
  if (r.expGolomb() === 3) {
    r.bits(1);
  }
  r.expGolomb();
  r.expGolomb();
  if (r.bits(1)) {
    for (let i = 0; i < 4; i++) {
      r.expGolomb();
    }
  }
  r.expGolomb();
  r.expGolomb();
  const pocLsbBits = r.expGolomb() + 4;
  for (
    let i = r.bits(1) ? 0 : maxSubLayersMinus1;
    i <= maxSubLayersMinus1;
    i++
  ) {
    for (let j = 0; j < 3; j++) {
      r.expGolomb();
    }
  }
  for (let i = 0; i < 6; i++) {
    r.expGolomb();
  }

  if (r.bits(1) && r.bits(1)) {
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
        if (r.bits(1) === 0) {
          r.expGolomb();
          continue;
        }
        if (sizeId > 1) {
          r.expGolomb();
        }
        const coefficients = Math.min(64, 1 << (4 + (sizeId << 1)));
        for (let i = 0; i < coefficients; i++) {
          r.expGolomb();
        }
      }
    }
  }

  r.bits(2);
  if (r.bits(1)) {
    r.bits(8);
    r.expGolomb();
    r.expGolomb();
    r.bits(1);
  }

  const refPicSets = r.expGolomb();
  let deltaPocs = 0;
  for (let i = 0; i < refPicSets; i++) {
    if (i > 0 && r.bits(1)) {
      r.bits(1);
      r.expGolomb();
      let predicted = 0;
      for (let j = 0; j <= deltaPocs; j++) {
        if (r.bits(1) || r.bits(1)) {
          predicted++;
        }
      }
      deltaPocs = predicted;
    } else {
      deltaPocs = r.expGolomb() + r.expGolomb();
      for (let j = 0; j < deltaPocs; j++) {
        r.expGolomb();
        r.bits(1);
      }
    }
  }

  if (r.bits(1)) {
    const longTermPics = r.expGolomb();
    for (let i = 0; i < longTermPics; i++) {
      r.bits(pocLsbBits + 1);
    }
  }

  r.bits(2);
  if (!r.bits(1)) {
    return UNSPECIFIED;
  }

  if (r.bits(1) && r.bits(8) === 255) {
    r.bits(32);
  }
  if (r.bits(1)) {
    r.bits(1);
  }
  if (!r.bits(1)) {
    return UNSPECIFIED;
  }
  r.bits(4);
  if (!r.bits(1)) {
    return UNSPECIFIED;
  }
  r.bits(8);
  return r.bits(8);
}
