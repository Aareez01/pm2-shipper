import { describe, it, expect } from 'vitest';
import { discoverTargets } from '../../src/rotate/discover';
import { Pm2Process } from '../../src/pm2/types';

const proc = (over: Partial<Pm2Process['pm2_env']> & { name?: string; pm_id?: number }):
  Pm2Process => {
  const { name = 'api', pm_id = 0, ...env } = over;
  return { name, pm_id, pm2_env: { name, pm_id,
    pm_out_log_path: `/logs/${name}-out-${pm_id}.log`,
    pm_err_log_path: `/logs/${name}-err-${pm_id}.log`, ...env } };
};

const opts = { selfName: 'pm2-shipper', includeModules: true, only: [], exclude: [] };

describe('discoverTargets', () => {
  it('finds both streams for an app', () => {
    const d = discoverTargets([proc({})], opts);
    expect(d.targets.map((t) => t.stream).sort()).toEqual(['err', 'out']);
  });

  it('treats per-instance paths as separate files', () => {
    const d = discoverTargets([proc({ pm_id: 0 }), proc({ pm_id: 1 })], opts);
    expect(d.targets).toHaveLength(4);
    expect(d.targets.every((t) => t.merged === false)).toBe(true);
  });

  it('deduplicates by PATH so merge_logs is one target, not one per instance', () => {
    // With merge_logs every instance appends to the same file; rotating it once per
    // instance would rotate a file that had just been rotated.
    const shared = { pm_out_log_path: '/logs/api-out.log',
      pm_err_log_path: '/logs/api-err.log', merge_logs: true };
    const d = discoverTargets(
      [proc({ pm_id: 0, ...shared }), proc({ pm_id: 1, ...shared })], opts);
    expect(d.targets).toHaveLength(2);
    const out = d.targets.find((t) => t.stream === 'out')!;
    expect(out.merged).toBe(true);
    expect(out.pmIds.sort()).toEqual([0, 1]);
  });

  it('never rotates its own log', () => {
    const d = discoverTargets([proc({ name: 'pm2-shipper' })], opts);
    expect(d.targets).toHaveLength(0);
  });

  it('reports an app whose logs go to a null device instead of ignoring it', () => {
    const d = discoverTargets([proc({ pm_out_log_path: '/dev/null' })], opts);
    expect(d.skipped[0]!.reason).toMatch(/null device/);
    expect(d.targets.map((t) => t.stream)).toEqual(['err']);  // err is still rotatable
  });

  it('reports an app with logs disabled', () => {
    const d = discoverTargets([proc({ disable_logs: true })], opts);
    expect(d.targets).toHaveLength(0);
    expect(d.skipped[0]!.reason).toMatch(/disabled/);
  });

  it('can leave other PM2 modules alone', () => {
    const m = proc({ name: 'pm2-liveness', pmx_module: true });
    expect(discoverTargets([m], opts).targets.length).toBeGreaterThan(0);
    expect(discoverTargets([m], { ...opts, includeModules: false }).targets).toHaveLength(0);
  });

  it('honours only and exclude', () => {
    const list = [proc({ name: 'api' }), proc({ name: 'web' })];
    expect(discoverTargets(list, { ...opts, only: ['api'] })
      .targets.every((t) => t.app === 'api')).toBe(true);
    expect(discoverTargets(list, { ...opts, exclude: ['api'] })
      .targets.every((t) => t.app === 'web')).toBe(true);
  });
});
