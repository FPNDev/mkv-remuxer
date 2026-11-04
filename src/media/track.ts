export type TrackKind = 'video' | 'audio' | 'subtitle';

/** A track as rendition, codec and playlist code see it, whatever the container. */
export type MediaTrack = {
  number: number;
  kind: TrackKind;
  codecId: string;
  codecPrivate?: string | undefined;
  name?: string | undefined;
  language: string;
  /** ISO 639-2, even when language holds BCP 47. */
  iso639Language: string;
  isDefault: boolean;
  isForced: boolean;
  isEnabled: boolean;
  defaultDurationNs?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  /** FlagInterlaced and FieldOrder as Matroska stores them. */
  interlaced?: number | undefined;
  fieldOrder?: number | undefined;
  transferCharacteristics?: number | undefined;
  sampleRate?: number | undefined;
  channels?: number | undefined;
  // The container's own description of the track, base64: the Matroska
  // TrackEntry element or the MP4 sample entry box, verbatim. Lets a rebuilt
  // header carry the track through byte for byte.
  entry: string;
};
