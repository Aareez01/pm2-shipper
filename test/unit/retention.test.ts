import { describe, it, expect } from 'vitest';
import { planRetention, Archive } from '../../src/rotate/retention';

const a = (name: string, sizeBytes: number, mtimeMs: number): Archive =>
  ({ path: `/logs/${name}`, sizeBytes, mtimeMs });

describe('planRetention', () => {
  it('keeps the newest and removes the oldest when over the count', () => {
    const plan = planRetention(
      [a('old', 10, 1), a('mid', 10, 2), a('new', 10, 3)],
      { maxTotalBytes: 0, maxArchives: 2 },
    );
    expect(plan.keep.map((x) => x.path)).toEqual(['/logs/new', '/logs/mid']);
    expect(plan.remove.map((x) => x.path)).toEqual(['/logs/old']);
    expect(plan.cappedByBytes).toBe(false);
  });

  it('enforces a BYTE budget, which a file count cannot', () => {
    // Thirty archives of a gigabyte each satisfy "keep 30" and still fill the disk.
    const big = [a('a', 600, 3), a('b', 600, 2), a('c', 600, 1)];
    const plan = planRetention(big, { maxTotalBytes: 1000, maxArchives: 30 });
    expect(plan.keep.map((x) => x.path)).toEqual(['/logs/a']);
    expect(plan.bytesFreed).toBe(1200);
    expect(plan.cappedByBytes).toBe(true);
  });

  it('applies whichever limit binds first', () => {
    const arr = [a('a', 10, 4), a('b', 10, 3), a('c', 10, 2), a('d', 10, 1)];
    expect(planRetention(arr, { maxTotalBytes: 1000, maxArchives: 2 }).keep).toHaveLength(2);
    expect(planRetention(arr, { maxTotalBytes: 25, maxArchives: 10 }).keep).toHaveLength(2);
  });

  it('removes everything when a single archive exceeds the whole budget', () => {
    const plan = planRetention([a('huge', 5000, 1)], { maxTotalBytes: 1000, maxArchives: 0 });
    expect(plan.keep).toHaveLength(0);
    expect(plan.remove).toHaveLength(1);
    expect(plan.cappedByBytes).toBe(true);
  });

  it('keeps everything when both limits are disabled', () => {
    const arr = [a('a', 10 ** 9, 2), a('b', 10 ** 9, 1)];
    expect(planRetention(arr, { maxTotalBytes: 0, maxArchives: 0 }).remove).toHaveLength(0);
  });

  it('is stable for an empty input', () => {
    const plan = planRetention([], { maxTotalBytes: 100, maxArchives: 5 });
    expect(plan).toMatchObject({ keep: [], remove: [], bytesFreed: 0 });
  });

  it('reports a count-only eviction as not byte-capped', () => {
    const plan = planRetention([a('a', 1, 2), a('b', 1, 1)],
      { maxTotalBytes: 1000, maxArchives: 1 });
    expect(plan.cappedByBytes).toBe(false);
  });
});
