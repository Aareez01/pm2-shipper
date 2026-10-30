import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigError, effectiveFor } from '../../src/config/schema';

describe('config', () => {
  it('applies defaults, parsing sizes into bytes', () => {
    const c = parseConfig({});
    expect(c.maxSize).toBe(10 * 1024 ** 2);
    expect(c.maxTotalSize).toBe(1024 ** 3);
    expect(c.maxArchives).toBe(30);
    expect(c.compress).toBe(true);
    expect(c.strategy).toBe('auto');
  });

  it('names the offending path on a bad size', () => {
    try {
      parseConfig({ maxSize: 'enormous' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join()).toMatch(/maxSize/);
      expect((e as ConfigError).issues.join()).toMatch(/not a size/);
    }
  });

  it('refuses a configuration where nothing would ever rotate', () => {
    expect(() => parseConfig({ maxSize: 0, intervalSeconds: 0 })).toThrow(ConfigError);
  });

  it('layers per-app overrides over the global policy', () => {
    const c = parseConfig({ maxSize: '10M', apps: { noisy: { maxSize: '100M' } } });
    expect(effectiveFor(c, 'noisy').maxSizeBytes).toBe(100 * 1024 ** 2);
    expect(effectiveFor(c, 'quiet').maxSizeBytes).toBe(10 * 1024 ** 2);
    expect(effectiveFor(c, 'noisy').maxArchives).toBe(30);
  });

  it('accepts a time-only policy', () => {
    const c = parseConfig({ maxSize: 0, intervalSeconds: 3600 });
    expect(c.intervalSeconds).toBe(3600);
  });
});
