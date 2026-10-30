import { Pm2Process, isNullPath, isModule } from '../pm2/types';

/**
 * Works out which files are worth rotating, from pm2.list().
 *
 * Two PM2 behaviours shape this. Log paths carry a `-<pm_id>` suffix per instance unless
 * `merge_logs` is set, in which case every instance of an app appends to ONE file - so
 * targets must be deduplicated by path, not by instance. And an app with logs disabled,
 * or pointed at a null device, has no file at all: it must be reported rather than
 * silently treated as "nothing to do".
 */

export interface LogTarget {
  app: string;
  /** Every instance writing to this path. More than one means merge_logs is on. */
  pmIds: number[];
  stream: 'out' | 'err';
  path: string;
  merged: boolean;
}

export interface Skipped {
  app: string;
  reason: string;
}

export interface Discovery {
  targets: LogTarget[];
  skipped: Skipped[];
}

export interface DiscoverOptions {
  /** This module's own PM2 name, so it never rotates its own log out from under itself. */
  selfName: string;
  /** Rotate other PM2 modules' logs too. They grow like anything else. */
  includeModules: boolean;
  /** Only these apps, when non-empty. */
  only: string[];
  exclude: string[];
}

export function discoverTargets(
  list: Pm2Process[],
  opts: DiscoverOptions,
): Discovery {
  const byPath = new Map<string, LogTarget>();
  const skipped = new Map<string, string>();

  for (const proc of list) {
    const app = proc.name ?? proc.pm2_env?.name;
    if (!app) continue;
    if (app === opts.selfName) continue;
    if (isModule(proc) && !opts.includeModules) continue;
    if (opts.only.length > 0 && !opts.only.includes(app)) continue;
    if (opts.exclude.includes(app)) continue;

    const env = proc.pm2_env ?? {};
    const pmId = proc.pm_id ?? env.pm_id;

    if (env.disable_logs === true) {
      skipped.set(app, 'logs are disabled for this app (disable_logs)');
      continue;
    }

    for (const stream of ['out', 'err'] as const) {
      const path = stream === 'out' ? env.pm_out_log_path : env.pm_err_log_path;
      if (isNullPath(path)) {
        skipped.set(app, `${stream} log is sent to a null device, so there is no file`);
        continue;
      }
      const existing = byPath.get(path as string);
      if (existing) {
        if (typeof pmId === 'number' && !existing.pmIds.includes(pmId)) {
          existing.pmIds.push(pmId);
          existing.merged = true;
        }
        continue;
      }
      byPath.set(path as string, {
        app,
        pmIds: typeof pmId === 'number' ? [pmId] : [],
        stream,
        path: path as string,
        merged: false,
      });
    }
  }

  return {
    targets: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    skipped: [...skipped.entries()].map(([app, reason]) => ({ app, reason })),
  };
}
