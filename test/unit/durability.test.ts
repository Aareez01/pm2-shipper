import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pipeline } from '../../src/ship/pipeline';
import { OffsetStore } from '../../src/ship/offsets';
import { Backend, DeliveryError } from '../../src/ship/backends';
import { LogRecord } from '../../src/ship/record';
import { LogTarget } from '../../src/rotate/discover';

class FakeBackend implements Backend {
  readonly name = 'fake'; readonly kind = 'fake';
  received: string[] = []; fail = false;
  async send(r: LogRecord[]): Promise<void> {
    if (this.fail) throw new DeliveryError('down', true);
    this.received.push(...r.map((x) => x.line));
  }
}

const opts = { maxBatchBytes: 1 << 20, maxBatchRecords: 1000, maxLineBytes: 65536,
  attempts: 1, baseBackoffMs: 1 };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dura-'));
  const path = join(dir, 'api-out.log');
  const offPath = join(dir, 'offsets.json');
  const target = (): LogTarget =>
    ({ app: 'api', pmIds: [0], stream: 'out', path, merged: false });
  return { dir, path, offPath, target };
}

describe('durability boundaries', () => {
  it('an outage plus a rotation loses nothing while the process stays up', async () => {
    // The follower holds the old descriptor, so it drains the archived inode even
    // though the path now points at a different file.
    const { dir, path, offPath, target } = setup();
    const store = new OffsetStore(offPath); store.load();
    const b = new FakeBackend();
    const p = new Pipeline(b, store, opts);

    writeFileSync(path, 'L1\nL2\n');
    await p.drain(target());

    b.fail = true;
    appendFileSync(path, 'L3\nL4\n');
    await p.drain(target());
    expect(b.received).toEqual(['L1', 'L2']);

    renameSync(path, join(dir, 'api-out.log.1'));
    writeFileSync(path, 'L5\n');

    b.fail = false;
    await p.drain(target());
    await p.drain(target());
    expect(b.received).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    await p.closeAll();
  });

  /**
   * KNOWN LIMITATION, asserted so it cannot drift into an unnoticed regression.
   *
   * A follower's descriptor does not survive a module restart. If a file is rotated by
   * something ELSE while this module is behind, and the module then restarts, the stored
   * offset refers to an inode that is no longer at the path and the backlog is stranded
   * in an archive nobody follows.
   *
   * The module's own rotation defers while a backlog exists, so it cannot cause this.
   * An external rotator (system logrotate) still can.
   */
  it('a restart after an EXTERNAL rotation strands the unshipped backlog', async () => {
    const { dir, path, offPath, target } = setup();
    const store1 = new OffsetStore(offPath); store1.load();
    const b1 = new FakeBackend();
    const p1 = new Pipeline(b1, store1, opts);

    writeFileSync(path, 'L1\n');
    await p1.drain(target());

    b1.fail = true;
    appendFileSync(path, 'L2\nL3\n');
    await p1.drain(target());

    renameSync(path, join(dir, 'api-out.log.1'));   // something else rotated it
    writeFileSync(path, 'L4\n');
    store1.flush(true);
    await p1.closeAll();                            // the module restarts here

    const store2 = new OffsetStore(offPath); store2.load();
    const b2 = new FakeBackend();
    const p2 = new Pipeline(b2, store2, opts);
    await p2.drain(target());

    expect(b2.received).toContain('L4');
    // L2 and L3 are gone. Documented, not claimed otherwise.
    expect(b2.received).not.toContain('L2');
    await p2.closeAll();
  });

  it('a stale offset never skips the head of a newly rotated-in file', async () => {
    const { dir, path, offPath, target } = setup();
    const store = new OffsetStore(offPath); store.load();
    const b = new FakeBackend();
    const p = new Pipeline(b, store, opts);

    writeFileSync(path, 'x'.repeat(100) + '\n');
    await p.drain(target());
    await p.closeAll();

    renameSync(path, join(dir, 'api-out.log.1'));
    writeFileSync(path, 'first-line-of-new-file\n');

    const p2 = new Pipeline(b, store, opts);
    await p2.drain(target());
    expect(b.received).toContain('first-line-of-new-file');
    await p2.closeAll();
  });
});
