import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pipeline } from '../../src/ship/pipeline';
import { OffsetStore } from '../../src/ship/offsets';
import { Backend, DeliveryError } from '../../src/ship/backends';
import { LogRecord } from '../../src/ship/record';
import { LogTarget } from '../../src/rotate/discover';

/** A backend that can refuse, so the durability path is exercised rather than assumed. */
class FakeBackend implements Backend {
  readonly name = 'fake';
  readonly kind = 'fake';
  received: string[] = [];
  failTimes = 0;
  failRetryable = true;
  calls = 0;

  async send(records: LogRecord[]): Promise<void> {
    this.calls++;
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new DeliveryError('refused', this.failRetryable);
    }
    this.received.push(...records.map((r) => r.line));
  }
}

let dir: string;
let path: string;
let backend: FakeBackend;
let offsets: OffsetStore;
let pipe: Pipeline;

const target = (): LogTarget =>
  ({ app: 'api', pmIds: [0], stream: 'out', path, merged: false });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  path = join(dir, 'api-out.log');
  backend = new FakeBackend();
  offsets = new OffsetStore(join(dir, 'offsets.json'));
  pipe = new Pipeline(backend, offsets, {
    maxBatchBytes: 1024 * 1024, maxBatchRecords: 1000, maxLineBytes: 65536,
    attempts: 2, baseBackoffMs: 1,
  });
});

// A Pipeline holds an open descriptor per followed file. Leaving them to the garbage
// collector is an error from Node 26 on, and a test that leaks them is also failing to
// exercise the shutdown path the module relies on.
afterEach(async () => {
  await pipe.closeAll();
});

describe('at-least-once delivery', () => {
  it('ships lines and commits the offset once accepted', async () => {
    writeFileSync(path, 'one\ntwo\n');
    await pipe.drain(target());
    expect(backend.received).toEqual(['one', 'two']);
    expect(offsets.get(path)?.offset).toBe(8);
  });

  it('does NOT commit an offset for a batch the backend refused', async () => {
    // Committing first is the bug that loses data exactly when logs matter.
    writeFileSync(path, 'one\ntwo\n');
    backend.failTimes = 99;
    await pipe.drain(target());
    expect(backend.received).toEqual([]);
    expect(offsets.get(path)).toBeUndefined();
  });

  it('re-reads the same bytes after an outage, losing nothing', async () => {
    writeFileSync(path, 'one\ntwo\n');
    backend.failTimes = 99;
    await pipe.drain(target());        // backend down
    backend.failTimes = 0;             // backend returns
    await pipe.drain(target());
    expect(backend.received).toEqual(['one', 'two']);
    expect(offsets.get(path)?.offset).toBe(8);
  });

  it('holds data on disk across a long outage and ships it all afterwards', async () => {
    writeFileSync(path, 'a\n');
    backend.failTimes = 99;
    for (let i = 0; i < 5; i++) {
      appendFileSync(path, `line${i}\n`);
      await pipe.drain(target());
    }
    expect(backend.received).toEqual([]);
    backend.failTimes = 0;
    await pipe.drain(target());
    expect(backend.received).toEqual(['a', 'line0', 'line1', 'line2', 'line3', 'line4']);
  });

  it('retries a retryable failure, and gives up quickly on a permanent one', async () => {
    writeFileSync(path, 'x\n');
    backend.failTimes = 1;
    await pipe.drain(target());
    expect(backend.received).toEqual(['x']);
    expect(backend.calls).toBe(2);         // one failure, one success

    backend.calls = 0;
    backend.failTimes = 99;
    backend.failRetryable = false;         // e.g. a 400: retrying cannot help
    appendFileSync(path, 'y\n');
    await pipe.drain(target());
    expect(backend.calls).toBe(1);         // no pointless retries
  });

  it('survives a module restart without re-shipping or skipping', async () => {
    writeFileSync(path, 'first\n');
    await pipe.drain(target());
    offsets.flush(true);

    // New process: fresh store reading the persisted offsets.
    const reopened = new OffsetStore(join(dir, 'offsets.json'));
    reopened.load();
    const second = new FakeBackend();
    const pipe2 = new Pipeline(second, reopened, {
      maxBatchBytes: 1024 * 1024, maxBatchRecords: 1000, maxLineBytes: 65536,
      attempts: 2, baseBackoffMs: 1,
    });
    appendFileSync(path, 'second\n');
    await pipe2.drain(target());
    expect(second.received).toEqual(['second']);   // not 'first' again
    await pipe2.closeAll();
  });

  it('ships the tail of a rotated file before following the new one', async () => {
    writeFileSync(path, 'old1\n');
    await pipe.drain(target());
    appendFileSync(path, 'old2\n');
    renameSync(path, join(dir, 'api-out.log.1'));
    writeFileSync(path, 'new1\n');
    await pipe.drain(target());
    expect(backend.received).toEqual(['old1', 'old2', 'new1']);
  });

  it('does nothing at all when no backend is configured', async () => {
    writeFileSync(path, 'x\n');
    const idle = new Pipeline(null, offsets, {
      maxBatchBytes: 1024, maxBatchRecords: 10, maxLineBytes: 1024,
      attempts: 1, baseBackoffMs: 1,
    });
    await idle.drain(target());
    expect(offsets.get(path)).toBeUndefined();
  });
});
