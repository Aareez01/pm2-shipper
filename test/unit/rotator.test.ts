import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Rotator, defaultStrategy } from '../../src/rotate/rotator';
import { Pm2Client } from '../../src/pm2/client';
import { LogTarget } from '../../src/rotate/discover';

/** Records whether reloadLogs was called, and can fail on demand. */
class FakeClient {
  reloadCalls = 0;
  reloadResult = true;
  /** Filenames present when reloadLogs ran - proves ordering. */
  dirAtReload: string[] = [];
  constructor(private readonly dir: string) {}
  async reloadLogs(): Promise<boolean> {
    this.reloadCalls++;
    this.dirAtReload = readdirSync(this.dir);
    // PM2 recreates the file on reopen; emulate that so verification can pass.
    if (this.reloadResult) writeFileSync(join(this.dir, 'app-out.log'), '');
    return this.reloadResult;
  }
}

let dir: string;
let logPath: string;
let fake: FakeClient;

const target = (): LogTarget => ({
  app: 'api', pmIds: [0], stream: 'out', path: logPath, merged: false,
});

const build = (over: Partial<ConstructorParameters<typeof Rotator>[1]> = {}) =>
  new Rotator(fake as unknown as Pm2Client, {
    strategy: 'rename', compress: true, verifyTimeoutMs: 2000, ...over,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipper-'));
  logPath = join(dir, 'app-out.log');
  writeFileSync(logPath, 'x'.repeat(5000));
  fake = new FakeClient(dir);
});

describe('the rotation protocol', () => {
  it('renames, then reloads, then compresses - in that order', async () => {
    const res = await build().rotate(target(), new Date(2026, 9, 31, 12, 0, 0));
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.compressed).toBe(true);
    expect(fake.reloadCalls).toBe(1);

    // Decisive: at the moment reloadLogs ran, the archive existed and was NOT yet
    // gzipped. Compressing earlier would race with workers still holding the old fd.
    expect(fake.dirAtReload.some((f) => f.startsWith('app-out.log.2026'))).toBe(true);
    expect(fake.dirAtReload.some((f) => f.endsWith('.gz'))).toBe(false);

    const after = readdirSync(dir);
    expect(after.some((f) => f.endsWith('.gz'))).toBe(true);
    expect(existsSync(logPath)).toBe(true);
  });

  it('does NOT compress when PM2 failed to reopen', async () => {
    // Workers may still be appending to the archive; compressing it would truncate
    // live data and hide a file that is still growing.
    fake.reloadResult = false;
    const res = await build().rotate(target());
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.compressed).toBe(false);
    expect(readdirSync(dir).some((f) => f.endsWith('.gz'))).toBe(false);
  });

  it('preserves the rotated bytes', async () => {
    const res = await build({ compress: false }).rotate(target());
    expect(res.bytesRotated).toBe(5000);
    expect(statSync(res.archivePath as string).size).toBe(5000);
  });

  it('does nothing for an empty file', async () => {
    writeFileSync(logPath, '');
    const res = await build().rotate(target());
    expect(res.ok).toBe(true);
    expect(res.archivePath).toBeUndefined();
    expect(fake.reloadCalls).toBe(0);
  });

  it('refuses rather than pretending, when the strategy is refuse', async () => {
    const res = await build({ strategy: 'refuse' }).rotate(target());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Windows/);
    expect(existsSync(logPath)).toBe(true);     // nothing was touched
    expect(fake.reloadCalls).toBe(0);
  });

  it('copy-truncate leaves the inode alone and needs no reopen', async () => {
    const before = statSync(logPath).ino;
    const res = await build({ strategy: 'copy-truncate' }).rotate(target());
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(fake.reloadCalls).toBe(0);
    expect(statSync(logPath).ino).toBe(before);
    expect(statSync(logPath).size).toBe(0);
  });

  it('reports a missing file instead of throwing', async () => {
    const res = await build().rotate({ ...target(), path: join(dir, 'nope.log') });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cannot stat/);
  });
});

describe('defaultStrategy', () => {
  it('refuses on Windows, where renaming an open file fails', () => {
    expect(defaultStrategy('win32')).toBe('refuse');
  });
  it('renames elsewhere', () => {
    expect(defaultStrategy('linux')).toBe('rename');
    expect(defaultStrategy('darwin')).toBe('rename');
  });
});
