// Serves the videos under a directory as HLS. Every subdirectory of the root is
// a source; every file below it is a file of that source.
//
//   npm run build
//   node examples/directory-server.ts <root> [port] [cacheDir]
//
// Then open http://localhost:8080/ for the list of master playlists.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  AbandonedError,
  createHlsService,
  MatroskaError,
  MediaTimeoutError,
  NotFoundError,
  UnsupportedMediaError,
  type SourceFile,
  type SourceProvider,
} from '@rimjoeh/mkv-remuxer';

type LocalFile = SourceFile & { path: string };

type LocalSource = {
  id: string;
  name: string;
  files: LocalFile[];
};

const [
  root = '.',
  port = '8080',
  cacheDir = path.join(tmpdir(), 'mkv-remuxer-example'),
] = process.argv.slice(2);

// Ids end up in URLs and cache paths, so names are hashed into safe ones. A
// hash of the path stays the same when other files come and go.
function idOf(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 16);
}

async function scan(dir: string): Promise<LocalSource[]> {
  const sources: LocalSource[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sourceDir = path.join(dir, entry.name);
    const entries = await readdir(sourceDir, {
      recursive: true,
      withFileTypes: true,
    });
    const files: LocalFile[] = [];
    for (const file of entries) {
      if (!file.isFile()) {
        continue;
      }
      const full = path.join(file.parentPath, file.name);
      const relative = path.relative(sourceDir, full);
      files.push({
        id: idOf(relative),
        name: file.name,
        path: full,
        length: (await stat(full)).size,
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    sources.push({ id: idOf(entry.name), name: entry.name, files });
  }
  return sources;
}

let sources = new Map<string, LocalSource>();

async function rescan(): Promise<void> {
  sources = new Map();
  for (const source of await scan(root)) {
    sources.set(source.id, source);
  }
}

// A miss rescans the root, so files added since the last scan are found.
async function sourceOf(sourceId: string): Promise<LocalSource> {
  if (!sources.has(sourceId)) {
    await rescan();
  }
  const source = sources.get(sourceId);
  if (!source) {
    throw new NotFoundError(`No source ${sourceId}`);
  }
  return source;
}

async function fileOf(sourceId: string, fileId: string): Promise<LocalFile> {
  const find = (source: LocalSource) =>
    source.files.find((file) => file.id === fileId);
  let file = find(await sourceOf(sourceId));
  if (!file) {
    await rescan();
    file = find(await sourceOf(sourceId));
  }
  if (!file) {
    throw new NotFoundError(`No file ${fileId} in source ${sourceId}`);
  }
  return file;
}

await rescan();

const provider: SourceProvider = {
  async list(sourceId) {
    return { files: (await sourceOf(sourceId)).files };
  },

  async lease(sourceId, fileId, _hint, work) {
    const file = await fileOf(sourceId, fileId);
    return work({
      name: file.name,
      length: file.length,
      // end is exclusive here and inclusive for createReadStream.
      stream: (start, end) =>
        end > start
          ? createReadStream(file.path, { start, end: end - 1 })
          : Readable.from([]),
    });
  },
};

const hls = await createHlsService({
  cacheDir,
  provider,
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  logger: console,
});

function statusOf(err: unknown): number {
  if (err instanceof NotFoundError) {
    return 404;
  }
  if (err instanceof UnsupportedMediaError || err instanceof MatroskaError) {
    return 422;
  }
  if (err instanceof MediaTimeoutError) {
    return 504;
  }
  return 500;
}

async function index(res: ServerResponse): Promise<void> {
  const list = [];
  for (const source of sources.values()) {
    const playable = [];
    for (const file of (await hls.files(source.id)).files) {
      if (file.playable) {
        playable.push({
          name: file.name,
          master: `/${source.id}/${file.id}/master.m3u8`,
        });
      }
    }
    list.push({ source: source.name, files: playable });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(list, null, 2));
}

const server = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');

  // A client that leaves cancels the work only it was waiting for.
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) {
      controller.abort(new AbandonedError('Request ended'));
    }
  });

  const handle = async (): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      await index(res);
      return;
    }
    // /<sourceId>/<fileId>/master.m3u8, /<sourceId>/<fileId>/video/00001.m4s...
    const [sourceId = '', fileId = '', ...parts] = url.pathname
      .slice(1)
      .split('/');
    const file = await hls.resolve(sourceId, fileId, parts, controller.signal);
    res.writeHead(200, {
      'content-type': file.contentType,
      'cache-control': file.cacheControl,
    });
    createReadStream(file.path).pipe(res);
  };

  handle().catch((err: unknown) => {
    if (err instanceof AbandonedError) {
      return;
    }
    const status = statusOf(err);
    if (status === 500) {
      console.error(err);
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  });
});

server.listen(Number(port), () => {
  console.log(`Serving ${root} on http://localhost:${port}/`);
});

process.once('SIGINT', () => {
  server.close();
  hls.close();
});
