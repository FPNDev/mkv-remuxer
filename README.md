# MKV & WebM remuxer [![npm version](https://img.shields.io/npm/v/@rimjoeh/mkv-remuxer.svg)](https://www.npmjs.com/package/@rimjoeh/mkv-remuxer)

Turns Matroska and WebM files into HLS on demand. Video and audio are
remuxed into fragmented MP4, subtitles into WebVTT. Nothing is transcoded,
and only the byte ranges a player asks for are read, so playback can start
before the whole file is available.

The library never opens files or network connections itself. The host hands
it a `SourceProvider`, which supplies random-access bytes for each source, and
the library takes care of indexing, segment planning, remuxing through
ffmpeg, job scheduling and the on-disk cache.

## Requirements

- Node.js 22 or newer.
- An `ffmpeg` binary. The library checks it once at startup.

## Install

```sh
npm install @rimjoeh/mkv-remuxer
```

## Usage

```ts
import { createHlsService, type SourceProvider } from '@rimjoeh/mkv-remuxer';

const provider: SourceProvider = {
  async list(sourceId) {
    return { files: await catalog.files(sourceId) };
  },
  async lease(sourceId, fileId, hint, work) {
    const source = await catalog.open(sourceId, fileId);
    try {
      return await work(source);
    } finally {
      await source.close();
    }
  },
};

const hls = await createHlsService({
  cacheDir: '/var/cache/remuxer',
  provider,
  ffmpegPath: '/usr/bin/ffmpeg',
});

// GET /:sourceId/:fileId/*parts
const file = await hls.resolve(sourceId, fileId, parts, signal);
// file.path is on disk; send it with file.contentType and file.cacheControl.
```

`catalog` stands for whatever the host uses to find and open its files.
[`examples/directory-server.ts`](examples/directory-server.ts) is a complete
server over a directory of videos, using only `node:http` and `node:fs`.

### Routing

Every URL the library produces has the shape `<sourceId>/<fileId>/...`, and
`resolve` serves all of them, the master playlist included:

| Path                                              | Serves               |
| ------------------------------------------------- | -------------------- |
| `<sourceId>/<fileId>/master.m3u8`                 | Master playlist      |
| `<sourceId>/<fileId>/video/index.m3u8`            | Video media playlist |
| `<sourceId>/<fileId>/audio/<track>/init.mp4`      | Audio init segment   |
| `<sourceId>/<fileId>/subtitles/<track>/00003.vtt` | Subtitle segment     |

Rendition URIs in the master are relative to the master's own URL. A host
that serves the master from elsewhere sets `masterUriPrefix` so those URIs
still land under `<sourceId>/<fileId>/`.

`resolve` checks every path part before it touches the disk. It returns a
`ServedFile`: a path on disk plus the content type and cache header to send.

### Methods

| Method                                      | Does                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `createHlsService(options)`                 | Checks ffmpeg, loads the cache from disk, starts the cache sweep.                 |
| `master(sourceId, fileId?, signal?)`        | Master playlist. Without `fileId`, the first Matroska or WebM file of the source. |
| `resolve(sourceId, fileId, parts, signal?)` | Master, media playlist, init segment or media segment for one path.               |
| `warm(sourceId, fileId?)`                   | Prepares the opening segments in the background and reports progress.             |
| `files(sourceId, signal?)`                  | File list of a source, each file marked `playable` when it is Matroska or WebM.   |
| `status()`                                  | Job counts and cache usage.                                                       |
| `close()`                                   | Stops the cache sweep and kills running ffmpeg processes.                         |

Source and file ids are 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `_` and
`-`. The provider picks them; they name cache directories and URLs, so a file
must keep its id for as long as its cache should stay valid.

Pass a request's `AbortSignal` as `signal`. Once every caller waiting on a
job has gone, the job is cancelled, including its ffmpeg process.

## Source provider

```ts
interface SourceProvider {
  list(sourceId: string): Promise<SourceListing>;
  lease<T>(
    sourceId: string,
    fileId: string,
    hint: ReadHint,
    work: (source: LeasedSource) => Promise<T>,
  ): Promise<T>;
  touch?(sourceId: string): void;
  warm?(sourceId: string): void;
  active?(): Set<string>;
}
```

- `list` returns the files of a source, each with `id`, `name` and `length`.
  Extra fields on the result and on each file are passed through by `files`.
- `lease` runs `work` over one file and keeps the file open while `work`
  runs. `hint.purpose` is `'index'` when the library reads the file's
  metadata, with a `signal` that cancels the read, and `'media'` when it
  renders a segment, with `foreground` set when a player is waiting for it.
- `touch` is called on every media request for a source.
- `warm` is called before background warming of a source starts.
- `active` names the sources in use. Their cached metadata is never evicted.

A `LeasedSource` is a `ByteSource` with a `name` plus optional hooks:

| Member                  | Meaning                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `length`                | File size in bytes.                                                                                 |
| `name`                  | File name. It must end in `.mkv` or `.webm`.                                                        |
| `stream(start, end)`    | `Readable` over `[start, end)`.                                                                     |
| `minReadBytes?`         | Shorter reads are widened to this size.                                                             |
| `prefetch?(start, end)` | Hint that the range will be read soon.                                                              |
| `promote?()`            | A player is now waiting on this read.                                                               |
| `release?()`            | The work over this source failed; drop state kept for it.                                           |
| `onCorrupt?(listener)`  | Report data found corrupt after it was read. The library then deletes what it built from that file. |

## Options

| Option                  | Default              | Meaning                                                                                                                                                                           |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cacheDir`              | required             | Root of the on-disk cache. HLS output goes to `<cacheDir>/hls`.                                                                                                                   |
| `provider`              | required             | The `SourceProvider`.                                                                                                                                                             |
| `ffmpegPath`            | `'ffmpeg'`           | ffmpeg binary.                                                                                                                                                                    |
| `segmentDuration`       | `2`                  | Target segment length in seconds.                                                                                                                                                 |
| `keepWarmS`             | `5`                  | After a segment is served, the next ones render in the background and are dropped unless requested within this many seconds (at least `segmentDuration + 1`). `0` turns this off. |
| `warmSegments`          | `2`                  | Segments rendered ahead: by `warm` from the start of a file, and after each served segment.                                                                                       |
| `warmConcurrency`       | `4`                  | Sources warmed at the same time.                                                                                                                                                  |
| `requestTimeoutMs`      | `120000`             | Longest wait for one playlist or segment.                                                                                                                                         |
| `maxConcurrentJobs`     | `64`                 | Remux jobs running at once.                                                                                                                                                       |
| `jobTimeoutMs`          | `180000`             | Longest run of one ffmpeg process.                                                                                                                                                |
| `audioReadFromKeyframe` | `true`               | Read audio from the preceding video keyframe, which suits files with loosely interleaved tracks.                                                                                  |
| `segmentCacheBytes`     | 15 GiB               | Budget for rendered segments.                                                                                                                                                     |
| `metadataCacheBytes`    | 2 GiB                | Budget for indexes and playlists.                                                                                                                                                 |
| `cacheTotalBytes`       | sum of the two above | Budget for everything under `cacheDir`, host stores included.                                                                                                                     |
| `cacheSweepMs`          | `300000`             | Interval of the cache sweep.                                                                                                                                                      |
| `hostStores`            | `{}`                 | Extra directories the host keeps under the same total budget. Each entry has `dir`, `oldestUsedAt()` and `evictOldest(bytes)`.                                                    |
| `hostDataDir`           | none                 | Directory with one subdirectory per source that the host keeps. Counted against the metadata budget and deleted with the source's metadata.                                       |
| `masterUriPrefix`       | none                 | `(sourceId, fileId) => string` prepended to rendition URIs in master playlists, for a master served from somewhere other than `<sourceId>/<fileId>/master.m3u8`.                  |
| `logger`                | silent               | Object with `debug`, `info`, `warn` and `error(message, fields?)`.                                                                                                                |

The sweep also deletes stale `*.tmp` files, older than one hour, under the
cache directory and the host store directories.

## Errors

| Class                   | When                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `NotFoundError`         | Unknown source, file, track or path.                                   |
| `UnsupportedMediaError` | The file is not Matroska or WebM, or a codec cannot be carried in HLS. |
| `MatroskaError`         | The file is malformed.                                                 |
| `MediaTimeoutError`     | `requestTimeoutMs` ran out.                                            |
| `FfmpegError`           | ffmpeg failed. `stderr` holds the tail of its output.                  |
| `AbandonedError`        | Every caller went away. Not a failure; nothing needs reporting.        |

Abort a request with `new AbandonedError(...)` as the reason so the library
treats it as a departed client.

## Build

```sh
npm install
npm run build
```

## License

AGPL-3.0-only. See `LICENSE`.
