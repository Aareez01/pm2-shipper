import { describe, it, expect } from 'vitest';
import { shouldRotate, parseSize } from '../../src/rotate/policy';

const P = { maxSizeBytes: 1000, intervalSeconds: 0 };

describe('shouldRotate', () => {
  it('rotates at the size threshold, measured from the real file size', () => {
    expect(shouldRotate(999, null, P, 0).rotate).toBe(false);
    const d = shouldRotate(1000, null, P, 0);
    expect(d.rotate).toBe(true);
    expect(d.reason).toBe('size');
  });

  it('never rotates an empty file', () => {
    expect(shouldRotate(0, null, P, 0).rotate).toBe(false);
    expect(shouldRotate(0, 1, { maxSizeBytes: 0, intervalSeconds: 1 }, 10_000_000).rotate)
      .toBe(false);
  });

  it('honours the interval trigger', () => {
    const p = { maxSizeBytes: 0, intervalSeconds: 60 };
    expect(shouldRotate(10, 1_000_000, p, 1_000_000 + 59_000).rotate).toBe(false);
    expect(shouldRotate(10, 1_000_000, p, 1_000_000 + 60_000).reason).toBe('interval');
  });

  it('does not rotate everything at once when it has never rotated before', () => {
    // A module restart must not trigger a rotation storm across every file.
    const p = { maxSizeBytes: 0, intervalSeconds: 60 };
    expect(shouldRotate(10_000_000, null, p, 9_999_999).rotate).toBe(false);
  });

  it('size wins over interval when both would fire', () => {
    const p = { maxSizeBytes: 100, intervalSeconds: 1 };
    expect(shouldRotate(500, 0, p, 10_000).reason).toBe('size');
  });

  it('a zero size threshold disables the size trigger', () => {
    expect(shouldRotate(10 ** 9, null, { maxSizeBytes: 0, intervalSeconds: 0 }, 0).rotate)
      .toBe(false);
  });
});

describe('parseSize', () => {
  it('parses the usual suffixes as binary multiples', () => {
    expect(parseSize('10M')).toBe(10 * 1024 ** 2);
    expect(parseSize('1G')).toBe(1024 ** 3);
    expect(parseSize('512K')).toBe(512 * 1024);
    expect(parseSize('100')).toBe(100);
    expect(parseSize('10mb')).toBe(10 * 1024 ** 2);
    expect(parseSize(2048)).toBe(2048);
  });

  it('accepts fractions and lower case', () => {
    expect(parseSize('1.5g')).toBe(Math.floor(1.5 * 1024 ** 3));
  });

  it('rejects nonsense rather than guessing', () => {
    for (const bad of ['', 'big', '10X', 'M10', null, undefined, -1]) {
      expect(parseSize(bad as string)).toBeNull();
    }
  });
});
