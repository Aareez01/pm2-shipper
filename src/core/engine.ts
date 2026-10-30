import { stat, readdir, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { ShipperConfig, effectiveFor } from '../config/schema';
import { Pm2Client } from '../pm2/client';
import { discoverTargets, LogTarget } from '../rotate/discover';
import { shouldRotate } from '../rotate/policy';
import { planRetention, Archive } from '../rotate/retention';
import { Rotator, defaultStrategy, RotateStrategy } from '../rotate/rotator';
import { log, logOnce } from '../log';
import * as metrics from './metrics';

export const SELF_NAME = 'pm2-shipper';

export class Engine {
  private rotator: Rotator;
  private lastRotatedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly client: Pm2Client,
    private config: ShipperConfig,
  ) {
    this.rotator = this.buildRotator();
  }

  private buildRotator(): Rotator {
    const strategy: RotateStrategy =
      this.config.strategy === 'auto' ? defaultStrategy() : this.config.strategy;
    if (strategy === 'refuse') {
      log.warn('rotation is disabled on this platform', {
        platform: process.platform,
        note: 'renaming a file PM2 holds open fails on Windows; set strategy to ' +
          '"copy-truncate" to rotate anyway',
      });
    }
    return new Rotator(this.client, {
      strategy,
      compress: this.config.compress,
      verifyTimeoutMs: this.config.verifyTimeoutMs,
    });
  }

  updateConfig(next: ShipperConfig): void {
    this.config = next;
    this.rotator = this.buildRotator();
  }

  start(): void {
    void this.cycle();
    this.timer = setInterval(() => void this.cycle(), this.config.checkSeconds * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass: discover, rotate what is due, then enforce the disk cap. */
  async cycle(): Promise<void> {
    if (this.stopped || this.running) return;   // never overlap: rotation is not reentrant
    this.running = true;
    try {
      const list = await this.client.list();
      const { targets, skipped } = discoverTargets(list, {
        selfName: SELF_NAME,
        includeModules: this.config.includeModules,
        only: this.config.only,
        exclude: this.config.exclude,
      });
      metrics.set('filesWatched', targets.length);
      metrics.set('appsUnrotatable', skipped.length);

      for (const s of skipped) {
        // Said once, loudly: an operator who believes an app is covered when it has no
        // log file at all is worse off than one who knows it is not.
        logOnce(`skip:${s.app}:${s.reason}`, 'warn', 'app cannot be rotated', {
          app: s.app, reason: s.reason,
        });
      }

      for (const t of targets) {
        await this.considerTarget(t);
      }
    } catch (err) {
      log.warn('rotation cycle failed', { error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  private async considerTarget(t: LogTarget): Promise<void> {
    const eff = effectiveFor(this.config, t.app);
    let size: number;
    try {
      size = (await stat(t.path)).size;
    } catch {
      return; // file not there yet, or removed between list and stat
    }

    const decision = shouldRotate(
      size,
      this.lastRotatedAt.get(t.path) ?? null,
      { maxSizeBytes: eff.maxSizeBytes, intervalSeconds: eff.intervalSeconds },
      Date.now(),
    );

    if (!decision.rotate) {
      // Record a baseline so the interval trigger measures from a known point rather
      // than firing on everything the first time the module runs.
      if (!this.lastRotatedAt.has(t.path)) this.lastRotatedAt.set(t.path, Date.now());
      await this.enforceRetention(t, eff);
      return;
    }

    log.info('rotating', {
      app: t.app, stream: t.stream, path: t.path,
      reason: decision.reason, detail: decision.detail,
      instances: t.merged ? t.pmIds.length : undefined,
    });

    const res = await this.rotator.rotate(t);
    if (!res.ok) {
      metrics.inc('rotationFailures');
      logOnce(`rotfail:${t.path}`, 'error', 'rotation failed', {
        app: t.app, path: t.path, error: res.error,
      });
      return;
    }
    this.lastRotatedAt.set(t.path, Date.now());
    metrics.inc('rotations');
    metrics.inc('bytesRotated', res.bytesRotated);
    if (res.compressed) metrics.inc('archivesCompressed');
    if (!res.verified) metrics.inc('reopenFailures');

    await this.enforceRetention(t, eff);
  }

  /**
   * The byte cap is the only thing that actually bounds disk usage, so it is enforced
   * on every pass rather than only after a rotation.
   */
  private async enforceRetention(
    t: LogTarget,
    eff: ReturnType<typeof effectiveFor>,
  ): Promise<void> {
    if (eff.maxTotalBytes <= 0 && eff.maxArchives <= 0) return;

    const dir = dirname(t.path);
    const prefix = `${basename(t.path)}.`;
    let archives: Archive[] = [];
    try {
      const names = await readdir(dir);
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        if (name === basename(t.path)) continue;
        const full = join(dir, name);
        try {
          const st = await stat(full);
          if (st.isFile()) {
            archives.push({ path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
          }
        } catch { /* vanished between readdir and stat */ }
      }
    } catch {
      return;
    }
    if (archives.length === 0) return;

    const plan = planRetention(archives, {
      maxTotalBytes: eff.maxTotalBytes,
      maxArchives: eff.maxArchives,
    });
    if (plan.remove.length === 0) return;

    for (const a of plan.remove) {
      try {
        await unlink(a.path);
        metrics.inc('archivesDeleted');
        metrics.inc('bytesFreed', a.sizeBytes);
      } catch (err) {
        log.warn('could not delete archive', { path: a.path, error: (err as Error).message });
      }
    }

    if (plan.cappedByBytes) {
      // Deleting logs is a real loss. It beats filling the disk, but it is never silent.
      metrics.inc('bytesDroppedToCap', plan.bytesFreed);
      log.warn('disk cap reached, oldest archives deleted', {
        app: t.app, path: t.path, deleted: plan.remove.length,
        bytesFreed: plan.bytesFreed, maxTotalBytes: eff.maxTotalBytes,
      });
    }
  }
}
