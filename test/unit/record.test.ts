import { describe, it, expect } from 'vitest';
import { toRecord } from '../../src/ship/record';
import { LogTarget } from '../../src/rotate/discover';

const target = (over: Partial<LogTarget> = {}): LogTarget => ({
  app: 'api', pmIds: [2], stream: 'out', path: '/logs/api-out-2.log', merged: false, ...over,
});

describe('toRecord', () => {
  it('carries the facts a query needs', () => {
    const r = toRecord('hello', target(), 'web-01', 1000);
    expect(r).toMatchObject({
      app: 'api', pmId: 2, stream: 'out', host: 'web-01', line: 'hello', timestamp: 1000,
    });
  });

  it("uses PM2's own timestamp prefix and strips it from the body", () => {
    const r = toRecord('2026-10-31T09:00:00.000Z: boot complete', target(), 'h', 999);
    expect(r.line).toBe('boot complete');
    expect(r.timestamp).toBe(Date.parse('2026-10-31T09:00:00.000Z'));
  });

  it('claims no pm_id when merge_logs makes it a lie', () => {
    // Several instances share one file, so no single instance owns the line.
    const r = toRecord('x', target({ merged: true, pmIds: [0, 1] }), 'h');
    expect(r.pmId).toBeNull();
  });

  it('lifts JSON lines into structured fields, keeping the original', () => {
    const r = toRecord('{"level":"error","msg":"boom","code":5}', target(), 'h');
    expect(r.fields).toEqual({ level: 'error', msg: 'boom', code: 5 });
    expect(r.line).toContain('boom');
  });

  it('does not mistake almost-JSON for JSON', () => {
    for (const l of ['{not json}', '{', 'plain text', '[1,2,3]']) {
      expect(toRecord(l, target(), 'h').fields).toBeUndefined();
    }
  });

  it('marks stderr distinctly', () => {
    expect(toRecord('x', target({ stream: 'err' }), 'h').stream).toBe('err');
  });
});
