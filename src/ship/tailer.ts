import { open, stat, FileHandle } from 'node:fs/promises';
import { Stats } from 'node:fs';
import { Offset } from './offsets';

/**
 * Follows one file by byte offset.
 *
 * Holds the descriptor open, so a rename does not break the read: the follower keeps
 * draining the inode it was already on and only switches once that inode is exhausted.
 * That is what makes "the tail of a rotated file" survive, which a path-based reader
 * cannot do.
 *
 * Offsets are returned, never committed here. The pipeline commits them after the
 * backend has accepted the data, so a crash costs duplicates and never a gap.
 */

export interface ReadResult {
  lines: string[];
  /** Offset to commit if, and only if, these lines are delivered. */
  offset: Offset;
  /** The follower moved to a new inode: the previous file was rotated away. */
  rotated: boolean;
  /** True when the current inode has been read to the end. */
  atEof: boolean;
}

const DEFAULT_CHUNK = 256 * 1024;

export class FileFollower {
  private handle: FileHandle | null = null;
  private dev = 0;
  private ino = 0;
  private pos = 0;
  /** A chunk can end mid-line; the remainder waits for the next read. */
  private partial = '';

  constructor(
    readonly path: string,
    private readonly maxLineBytes: number,
  ) {}

  get offset(): Offset {
    return { dev: this.dev, ino: this.ino, offset: this.pos };
  }

  /**
   * `from` is only honoured when it refers to the same inode that is on disk now.
   * A stale offset against a rotated-away inode would skip the head of the new file.
   */
  async open(from?: Offset): Promise<void> {
    const st = await stat(this.path);
    this.handle = await open(this.path, 'r');
    this.dev = st.dev;
    this.ino = st.ino;
    const sameFile = from && from.dev === st.dev && from.ino === st.ino;
    this.pos = sameFile ? Math.min(from.offset, st.size) : 0;
  }

  /**
   * Put the read position back to a known-delivered point.
   *
   * This is what makes the FILE the buffer rather than memory: a batch the backend
   * refused is simply re-read next cycle, so a long outage costs nothing but lag.
   */
  rewindTo(offset: Offset | undefined): void {
    this.partial = '';
    this.pos = offset && offset.dev === this.dev && offset.ino === this.ino
      ? offset.offset
      : 0;
  }

  async close(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    await h?.close().catch(() => undefined);
  }

  private async currentStat(): Promise<Stats | null> {
    try { return await stat(this.path); } catch { return null; }
  }

  async read(maxBytes = DEFAULT_CHUNK): Promise<ReadResult> {
    if (!this.handle) await this.open();
    const h = this.handle as FileHandle;

    const fdStat = await h.stat();
    // Truncation (copy-truncate, or an external tool) rewinds us rather than leaving
    // the offset past the end, where nothing would ever be read again.
    if (fdStat.size < this.pos) {
      this.pos = 0;
      this.partial = '';
    }

    const want = Math.min(maxBytes, Math.max(0, fdStat.size - this.pos));
    let lines: string[] = [];
    if (want > 0) {
      const buf = Buffer.alloc(want);
      const { bytesRead } = await h.read(buf, 0, want, this.pos);
      this.pos += bytesRead;
      lines = this.consume(buf.subarray(0, bytesRead).toString('utf8'));
    }

    const atEof = this.pos >= fdStat.size;

    // Only consider switching once the current inode is fully drained.
    let rotated = false;
    if (atEof) {
      const onDisk = await this.currentStat();
      if (onDisk && (onDisk.dev !== this.dev || onDisk.ino !== this.ino)) {
        if (this.partial) {
          lines.push(this.partial);   // a rotated file's last line has no newline
          this.partial = '';
        }
        await this.close();
        await this.open();
        rotated = true;
      }
    }

    return { lines, offset: this.offset, rotated, atEof };
  }

  private consume(text: string): string[] {
    const combined = this.partial + text;
    const idx = combined.lastIndexOf('\n');
    if (idx === -1) {
      // Never buffer without limit: one pathological line must not grow the heap.
      if (combined.length > this.maxLineBytes) {
        this.partial = '';
        return [combined.slice(0, this.maxLineBytes) + ' …[truncated]'];
      }
      this.partial = combined;
      return [];
    }
    this.partial = combined.slice(idx + 1);
    return combined.slice(0, idx).split('\n').filter((l) => l.length > 0);
  }
}
