import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { log } from '../log';

/**
 * Where we have read up to, per file.
 *
 * Written atomically (temp + rename) so a crash mid-write cannot leave a truncated file
 * that fails to parse and silently resets every offset to zero - which would re-ship
 * everything on disk.
 *
 * The identity of a file is (dev, ino), not its path. A path can be recreated by
 * rotation while the offset still refers to the old inode; carrying the offset over
 * would skip the head of the new file.
 */

export interface Offset {
  dev: number;
  ino: number;
  offset: number;
}

interface Persisted {
  version: 1;
  savedAt: number;
  offsets: Record<string, Offset>;
}

export function defaultOffsetPath(): string {
  const base = process.env.PM2_HOME ?? join(homedir(), '.pm2');
  return join(base, 'pm2-shipper-offsets.json');
}

export class OffsetStore {
  private map = new Map<string, Offset>();
  private dirty = false;

  constructor(private readonly path: string) {}

  load(): void {
    try {
      if (!existsSync(this.path)) return;
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Persisted;
      if (parsed?.version !== 1) return;
      this.map = new Map(Object.entries(parsed.offsets ?? {}));
      log.info('offsets restored', { files: this.map.size });
    } catch (err) {
      // Starting clean re-ships; losing the file must not stop the module booting.
      log.warn('could not read offsets, starting from the end of each file', {
        error: (err as Error).message,
      });
      this.map = new Map();
    }
  }

  get(path: string): Offset | undefined {
    return this.map.get(path);
  }

  /** Only ever called after a batch has been accepted by the backend. */
  commit(path: string, offset: Offset): void {
    this.map.set(path, offset);
    this.dirty = true;
  }

  forget(path: string): void {
    if (this.map.delete(path)) this.dirty = true;
  }

  flush(force = false): void {
    if (!this.dirty && !force) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      const data: Persisted = {
        version: 1,
        savedAt: Date.now(),
        offsets: Object.fromEntries(this.map),
      };
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (err) {
      log.warn('could not persist offsets', { error: (err as Error).message });
    }
  }
}
