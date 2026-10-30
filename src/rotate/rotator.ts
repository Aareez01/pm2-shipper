import { rename, stat, copyFile, truncate, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Pm2Client } from '../pm2/client';
import { LogTarget } from './discover';
import { compressFile } from './compress';
import { log } from '../log';

/**
 * The rotation protocol.
 *
 * Verified against PM2 7.1.1 by experiment: in cluster mode each WORKER holds its own
 * log file descriptor, so renaming a file does not redirect PM2's writes. The renamed
 * inode keeps growing and disappears from `ls` while the disk fills. Only `reloadLogs`
 * makes the daemon and every worker close and reopen their streams.
 *
 * Hence the order, which is not negotiable:
 *
 *      rename  ->  reloadLogs  ->  verify  ->  compress
 *
 * Compressing before the reopen races with writers that still hold the old descriptor,
 * and would produce a truncated archive and a file that keeps growing behind it.
 */

export type RotateStrategy = 'rename' | 'copy-truncate' | 'refuse';

export interface RotatorOptions {
  strategy: RotateStrategy;
  compress: boolean;
  /** How long to wait for the reopened file to appear. */
  verifyTimeoutMs: number;
}

export interface RotateResult {
  ok: boolean;
  archivePath?: string;
  bytesRotated: number;
  compressed: boolean;
  /** True when reloadLogs succeeded AND the new file appeared. */
  verified: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Rename is unavailable on Windows for a file held open, so pick honestly. */
export function defaultStrategy(platform: string = process.platform): RotateStrategy {
  return platform === 'win32' ? 'refuse' : 'rename';
}

export class Rotator {
  constructor(
    private readonly client: Pm2Client,
    private readonly opts: RotatorOptions,
  ) {}

  async rotate(target: LogTarget, now: Date = new Date()): Promise<RotateResult> {
    const base: RotateResult = {
      ok: false, bytesRotated: 0, compressed: false, verified: false,
    };

    if (this.opts.strategy === 'refuse') {
      return {
        ...base,
        error:
          'rotation is refused on this platform: renaming a file that PM2 holds open ' +
          'fails on Windows. Set strategy to "copy-truncate" to accept the small risk ' +
          'of losing lines written between the copy and the truncate.',
      };
    }

    let sizeBytes: number;
    try {
      sizeBytes = (await stat(target.path)).size;
    } catch (err) {
      return { ...base, error: `cannot stat ${target.path}: ${(err as Error).message}` };
    }
    if (sizeBytes === 0) return { ...base, ok: true };

    const archivePath = `${target.path}.${stamp(now)}`;

    // --- 1. move the data aside ---
    try {
      if (this.opts.strategy === 'copy-truncate') {
        // Anything written between these two calls is lost. That is inherent to the
        // strategy, which is why it is not the default anywhere it can be avoided.
        await copyFile(target.path, archivePath);
        await truncate(target.path, 0);
      } else {
        await rename(target.path, archivePath);
      }
    } catch (err) {
      return { ...base, error: `rotate failed: ${(err as Error).message}` };
    }

    // --- 2. make PM2 reopen, or the workers keep writing to the archive ---
    let verified = false;
    if (this.opts.strategy === 'rename') {
      const reloaded = await this.client.reloadLogs();
      verified = reloaded && (await this.waitForFile(target.path));
      if (!verified) {
        // Not fatal: the next cycle retries. But the archive must NOT be compressed
        // while something may still be appending to it.
        log.error('log file was rotated but PM2 did not reopen it', {
          app: target.app, path: target.path, archive: archivePath,
          note: 'workers may still be writing to the archive; compression skipped',
        });
        return { ...base, ok: true, archivePath, bytesRotated: sizeBytes, verified: false };
      }
    } else {
      verified = true; // copy-truncate never changes the inode
    }

    // --- 3. only now is the archive safe to touch ---
    let compressed = false;
    if (this.opts.compress) {
      try {
        await compressFile(archivePath);
        compressed = true;
      } catch (err) {
        log.warn('archive could not be compressed, leaving it uncompressed', {
          archive: archivePath, error: (err as Error).message,
        });
      }
    }

    return { ok: true, archivePath, bytesRotated: sizeBytes, compressed, verified };
  }

  private async waitForFile(path: string): Promise<boolean> {
    const deadline = Date.now() + this.opts.verifyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        await access(path, constants.F_OK);
        return true;
      } catch {
        await sleep(100);
      }
    }
    return false;
  }
}
