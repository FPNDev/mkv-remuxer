import { randomUUID } from 'node:crypto';
import {
  access,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';

// Cache sweeps recognise interrupted writes by this suffix and delete them.
export const TEMP_SUFFIX = '.tmp';

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Advisory mtime bump for LRU ordering. Fire and forget: a failure only costs
// eviction accuracy.
export function touchFile(path: string): void {
  const now = new Date();
  void utimes(path, now, now).catch(() => {});
}

/**
 * Returns undefined for a missing, unreadable or malformed file. Never
 * throws.
 */
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function tempPathFor(path: string): string {
  return `${path}.${randomUUID()}${TEMP_SUFFIX}`;
}

/**
 * Writes through a temp file in the same directory and renames, so a reader
 * never sees a half-written file and the rename stays on one filesystem.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const temp = tempPathFor(path);
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
