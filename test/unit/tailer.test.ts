import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileFollower } from '../../src/ship/tailer';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tail-'));
  path = join(dir, 'app.log');
});

describe('FileFollower', () => {
  it('reads whole lines and reports an offset to commit', async () => {
    writeFileSync(path, 'a\nb\nc\n');
    const f = new FileFollower(path, 1024);
    const r = await f.read();
    expect(r.lines).toEqual(['a', 'b', 'c']);
    expect(r.offset.offset).toBe(6);
    expect(r.atEof).toBe(true);
    await f.close();
  });

  it('holds back a partial final line until it is complete', async () => {
    writeFileSync(path, 'complete\npart');
    const f = new FileFollower(path, 1024);
    expect((await f.read()).lines).toEqual(['complete']);
    appendFileSync(path, 'ial\n');
    expect((await f.read()).lines).toEqual(['partial']);
    await f.close();
  });

  it('resumes from a stored offset for the SAME inode', async () => {
    writeFileSync(path, 'one\ntwo\n');
    const st = statSync(path);
    const f = new FileFollower(path, 1024);
    await f.open({ dev: st.dev, ino: st.ino, offset: 4 });
    expect((await f.read()).lines).toEqual(['two']);
    await f.close();
  });

  it('ignores an offset that belongs to a different inode', async () => {
    // Carrying an old offset onto a rotated-in file would skip its head.
    writeFileSync(path, 'fresh\n');
    const f = new FileFollower(path, 1024);
    await f.open({ dev: 1, ino: 999999, offset: 5000 });
    expect((await f.read()).lines).toEqual(['fresh']);
    await f.close();
  });

  it('drains the old inode to EOF before following the new file', async () => {
    // The point of holding the descriptor open: a rename must not lose the tail.
    writeFileSync(path, 'before1\nbefore2\n');
    const f = new FileFollower(path, 1024);
    expect((await f.read()).lines).toEqual(['before1', 'before2']);

    renameSync(path, join(dir, 'app.log.1'));
    appendFileSync(join(dir, 'app.log.1'), 'straggler\n');
    writeFileSync(path, 'after1\n');

    const r1 = await f.read();
    expect(r1.lines).toEqual(['straggler']);   // old inode first
    expect(r1.rotated).toBe(true);

    expect((await f.read()).lines).toEqual(['after1']);
    await f.close();
  });

  it('rewinds to the last committed point so a refused batch is re-read', async () => {
    writeFileSync(path, 'x\ny\n');
    const st = statSync(path);
    const f = new FileFollower(path, 1024);
    expect((await f.read()).lines).toEqual(['x', 'y']);
    f.rewindTo({ dev: st.dev, ino: st.ino, offset: 0 });
    expect((await f.read()).lines).toEqual(['x', 'y']);
    await f.close();
  });

  it('recovers from truncation instead of sitting past the end forever', async () => {
    writeFileSync(path, 'aaaa\nbbbb\n');
    const f = new FileFollower(path, 1024);
    await f.read();
    writeFileSync(path, 'c\n');          // truncate + rewrite, same inode
    expect((await f.read()).lines).toEqual(['c']);
    await f.close();
  });

  it('bounds a pathological line rather than growing the heap', async () => {
    writeFileSync(path, 'z'.repeat(5000));     // no newline at all
    const f = new FileFollower(path, 100);
    const r = await f.read();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.length).toBeLessThan(200);
    expect(r.lines[0]).toMatch(/truncated/);
    await f.close();
  });
});
