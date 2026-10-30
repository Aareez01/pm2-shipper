import { hostname } from 'node:os';
import { LogTarget } from '../rotate/discover';
import { FileFollower } from './tailer';
import { OffsetStore, Offset } from './offsets';
import { toRecord, LogRecord } from './record';
import { Backend, DeliveryError } from './backends';
import { log, logOnce } from '../log';
import * as metrics from '../core/metrics';

/**
 * Tail -> batch -> deliver -> commit.
 *
 * The ordering is the whole guarantee. An offset is committed ONLY after the backend has
 * accepted the batch, and a refused batch rewinds the follower to the last committed
 * point so the same bytes are read again next cycle. Delivery is therefore
 * at-least-once: a crash or an outage costs duplicates, never a gap.
 *
 * Advancing the offset first would be simpler and would silently lose data in exactly
 * the situation where logs matter most.
 */

export interface PipelineOptions {
  maxBatchBytes: number;
  maxBatchRecords: number;
  maxLineBytes: number;
  attempts: number;
  baseBackoffMs: number;
}

const HOST = hostname();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export class Pipeline {
  private followers = new Map<string, FileFollower>();

  constructor(
    private backend: Backend | null,
    private readonly offsets: OffsetStore,
    private readonly opts: PipelineOptions,
  ) {}

  setBackend(b: Backend | null): void {
    this.backend = b;
  }

  async closeAll(): Promise<void> {
    for (const f of this.followers.values()) await f.close();
    this.followers.clear();
  }

  /** Drop a file we are no longer following (app removed, or scaled down). */
  async forget(path: string): Promise<void> {
    const f = this.followers.get(path);
    if (f) {
      await f.close();
      this.followers.delete(path);
    }
  }

  /**
   * Read a file to the end and ship it, before something else moves it.
   *
   * The rotator calls this so the tail of a file is shipped while it is still the live
   * file. Without it, a rotation could archive and compress bytes we had not read.
   */
  async drain(target: LogTarget, maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const more = await this.pumpOne(target);
      if (!more) return;
    }
  }

  async pump(targets: LogTarget[]): Promise<void> {
    for (const t of targets) {
      try {
        await this.pumpOne(t);
      } catch (err) {
        logOnce(`pump:${t.path}`, 'warn', 'could not read log file', {
          path: t.path, error: (err as Error).message,
        });
      }
    }
  }

  /** One batch for one file. Returns true when there may be more to read. */
  private async pumpOne(target: LogTarget): Promise<boolean> {
    if (!this.backend) return false;

    let follower = this.followers.get(target.path);
    if (!follower) {
      follower = new FileFollower(target.path, this.opts.maxLineBytes);
      try {
        await follower.open(this.offsets.get(target.path));
      } catch {
        return false;   // not created yet
      }
      this.followers.set(target.path, follower);
    }

    const committed = this.offsets.get(target.path);
    const result = await follower.read(this.opts.maxBatchBytes);
    if (result.lines.length === 0) {
      if (result.rotated) this.offsets.commit(target.path, result.offset);
      return !result.atEof;
    }

    const lines = result.lines.slice(0, this.opts.maxBatchRecords);
    const records: LogRecord[] = lines.map((l) => toRecord(l, target, HOST));

    const delivered = await this.deliver(records);
    if (!delivered) {
      // The file keeps the data; re-read it next cycle rather than buffering it here.
      follower.rewindTo(committed);
      return false;
    }

    this.offsets.commit(target.path, result.offset);
    metrics.inc('linesShipped', records.length);
    metrics.inc('bytesShipped', records.reduce((n, r) => n + r.line.length, 0));
    return !result.atEof || result.rotated;
  }

  private async deliver(records: LogRecord[]): Promise<boolean> {
    const backend = this.backend;
    if (!backend) return false;

    for (let attempt = 1; attempt <= this.opts.attempts; attempt++) {
      try {
        await backend.send(records);
        return true;
      } catch (err) {
        const e = err as DeliveryError;
        const retryable = e instanceof DeliveryError ? e.retryable : true;
        if (!retryable || attempt === this.opts.attempts) {
          metrics.inc('deliveryFailures');
          logOnce(`deliver:${backend.name}:${e.message.slice(0, 40)}`, 'error',
            'delivery failed, log data is held on disk and will be retried', {
              backend: backend.name, records: records.length,
              attempts: attempt, retryable, error: e.message,
            });
          return false;
        }
        await sleep(this.opts.baseBackoffMs * 2 ** (attempt - 1));
      }
    }
    return false;
  }

  /** Unshipped bytes for one file: everything past the last committed offset. */
  backlogBytes(path: string, size: number): number {
    const off = this.offsets.get(path);
    if (!off) return size;
    return Math.max(0, size - off.offset);
  }

  /** Bytes behind the end of each file - the number that says whether we keep up. */
  lagFor(targets: LogTarget[], sizes: Map<string, number>): number {
    let lag = 0;
    for (const t of targets) {
      const size = sizes.get(t.path);
      const off = this.offsets.get(t.path);
      if (size === undefined || !off) continue;
      lag += Math.max(0, size - off.offset);
    }
    return lag;
  }
}
