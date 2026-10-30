import { z } from 'zod';
import { parseSize } from '../rotate/policy';

const size = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = parseSize(v);
  if (n === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: `not a size: expected something like "10M", "1G" or a byte count, got ${JSON.stringify(v)}` });
    return z.NEVER;
  }
  return n;
});

const appOverride = z.object({
  maxSize: size.optional(),
  intervalSeconds: z.number().nonnegative().optional(),
  maxTotalSize: size.optional(),
  maxArchives: z.number().int().nonnegative().optional(),
  compress: z.boolean().optional(),
});

export const configSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  checkSeconds: z.number().positive().default(30),

  /** Rotate when a file reaches this size. 0 disables the size trigger. */
  maxSize: size.default('10M'),
  /** Rotate at least this often. 0 disables the time trigger. */
  intervalSeconds: z.number().nonnegative().default(0),

  compress: z.boolean().default(true),

  /** Total bytes of archives kept per log file. This is the cap that actually binds. */
  maxTotalSize: size.default('1G'),
  /** Additional archive-count limit. Never the only limit - see retention.ts. */
  maxArchives: z.number().int().nonnegative().default(30),

  strategy: z.enum(['auto', 'rename', 'copy-truncate', 'refuse']).default('auto'),
  verifyTimeoutMs: z.number().int().positive().default(5000),

  includeModules: z.boolean().default(true),
  only: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),

  /** Shipping is opt-in: with no backend configured this module only rotates. */
  ship: z.object({
    enabled: z.boolean().default(false),
    backend: z.enum(['loki', 'otlp']).default('loki'),
    url: z.string().default(''),
    headers: z.record(z.string()).default({}),
    labels: z.record(z.string()).default({}),
    timeoutMs: z.number().int().positive().default(15_000),
    pollSeconds: z.number().positive().default(2),
    maxBatchBytes: size.default('1M'),
    maxBatchRecords: z.number().int().positive().default(5000),
    maxLineBytes: size.default('256K'),
    attempts: z.number().int().positive().max(10).default(4),
    baseBackoffMs: z.number().int().positive().default(1000),
    offsetFile: z.string().default(''),
    /**
     * Rotating a file that still has unshipped bytes abandons them: the follower's
     * descriptor does not survive a module restart, so the backlog would be stranded in
     * an archive nobody reads. Rotation is therefore deferred while a backlog exists -
     * but not forever, or a dead backend would fill the disk.
     */
    maxBacklogBytes: size.default('256M'),
  }).default({}),

  apps: z.record(appOverride).default({}),
}).refine((c) => c.maxSize > 0 || c.intervalSeconds > 0, {
  message: 'at least one of maxSize or intervalSeconds must be set, or nothing ever rotates',
}).refine((c) => !c.ship.enabled || c.ship.url.length > 0, {
  message: 'ship.enabled is true but ship.url is empty, so there is nowhere to send logs',
  path: ['ship', 'url'],
});

export type ShipperConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid pm2-shipper configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function parseConfig(raw: unknown): ShipperConfig {
  const r = configSchema.safeParse(raw);
  if (r.success) return r.data;
  throw new ConfigError(
    r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  );
}

/** Per-app overrides layered over the global policy. */
export function effectiveFor(cfg: ShipperConfig, app: string) {
  const o = cfg.apps[app] ?? {};
  return {
    maxSizeBytes: o.maxSize ?? cfg.maxSize,
    intervalSeconds: o.intervalSeconds ?? cfg.intervalSeconds,
    maxTotalBytes: o.maxTotalSize ?? cfg.maxTotalSize,
    maxArchives: o.maxArchives ?? cfg.maxArchives,
    compress: o.compress ?? cfg.compress,
  };
}
