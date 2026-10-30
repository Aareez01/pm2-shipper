import { createReadStream, createWriteStream } from 'node:fs';
import { unlink, stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

/**
 * Gzip an archive in place, then remove the original.
 *
 * Streamed rather than read-then-write: an archive is by definition as large as the
 * rotation threshold, and buffering it would make memory scale with the setting.
 */
export async function compressFile(path: string): Promise<{ gzPath: string; bytes: number }> {
  const gzPath = `${path}.gz`;
  await pipeline(createReadStream(path), createGzip(), createWriteStream(gzPath));
  const { size } = await stat(gzPath);
  await unlink(path);
  return { gzPath, bytes: size };
}
