import { childElements, readUint, type EbmlElement } from './ebml.js';
import { Id } from './ids.js';

export type CuePoint = {
  time: number;
  track: number;
  clusterPosition: number;
  // Offset of the block inside its cluster. Optional in the format and often
  // missing.
  relativePosition: number | undefined;
};

/**
 * One entry per CueTrackPositions, so a single time yields one entry per
 * indexed track. Positions stay relative to the Segment data start.
 */
export function parseCues(buf: Uint8Array, cues: EbmlElement): CuePoint[] {
  const result: CuePoint[] = [];

  for (const point of childElements(buf, cues.dataStart, cues.dataEnd)) {
    if (point.id !== Id.CuePoint) {
      continue;
    }

    let time: number | undefined;
    const positions: EbmlElement[] = [];
    for (const el of childElements(buf, point.dataStart, point.dataEnd)) {
      if (el.id === Id.CueTime) {
        time = readUint(buf, el);
      }
      if (el.id === Id.CueTrackPositions) {
        positions.push(el);
      }
    }
    if (time === undefined) {
      continue;
    }

    for (const pos of positions) {
      let track: number | undefined;
      let clusterPosition: number | undefined;
      let relativePosition: number | undefined;
      for (const el of childElements(buf, pos.dataStart, pos.dataEnd)) {
        if (el.id === Id.CueTrack) {
          track = readUint(buf, el);
        }
        if (el.id === Id.CueClusterPosition) {
          clusterPosition = readUint(buf, el);
        }
        if (el.id === Id.CueRelativePosition) {
          relativePosition = readUint(buf, el);
        }
      }
      if (track !== undefined && clusterPosition !== undefined) {
        result.push({ time, track, clusterPosition, relativePosition });
      }
    }
  }

  return result;
}
