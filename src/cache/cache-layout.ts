import path from 'node:path';

// Numbered segments, the only evictable files. Playlists and init segments are
// excluded so eviction never breaks a rendition's entry points.
const SEGMENT_FILE = /^\d+\.(m4s|vtt)$/u;

export function isSegmentFile(name: string): boolean {
  return SEGMENT_FILE.test(name);
}

/** Every path under the cache directory. Nothing else joins cache paths. */
export class CacheLayout {
  readonly hlsDir: string;

  constructor(readonly root: string) {
    this.hlsDir = path.join(root, 'hls');
  }

  // Its mtime records when the source was last asked for, across restarts.
  usedMarker(sourceId: string): string {
    return path.join(this.hlsDir, sourceId, '.used');
  }

  interleavingFile(): string {
    return path.join(this.root, 'interleaving.json');
  }

  mediaDir(sourceId: string, fileId: string): string {
    return path.join(this.hlsDir, sourceId, fileId);
  }

  indexFile(sourceId: string, fileId: string): string {
    return path.join(this.mediaDir(sourceId, fileId), 'index.json');
  }

  masterFile(sourceId: string, fileId: string): string {
    return path.join(this.mediaDir(sourceId, fileId), 'master.m3u8');
  }

  // relative is a playlist URI, so its separator is always a forward slash.
  mediaFile(sourceId: string, fileId: string, relative: string): string {
    return path.join(
      this.mediaDir(sourceId, fileId),
      ...relative.split('/'),
    );
  }
}
