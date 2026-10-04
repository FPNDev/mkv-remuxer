export const Id = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,

  Segment: 0x18538067,

  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,

  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,

  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  DefaultDuration: 0x23e383,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Colour: 0x55b0,
  TransferCharacteristics: 0x55ba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,

  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0,

  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,

  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
  Tags: 0x1254c367,

  Void: 0xec,
  CRC32: 0xbf,
} as const;

// Children of Segment. Hitting one of these while reading cluster data means
// the media is over.
export const TOP_LEVEL_IDS: ReadonlySet<number> = new Set([
  Id.SeekHead,
  Id.Info,
  Id.Tracks,
  Id.Cues,
  Id.Cluster,
  Id.Chapters,
  Id.Attachments,
  Id.Tags,
]);
