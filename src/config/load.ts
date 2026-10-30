import { readFileSync, existsSync, watch, FSWatcher, statSync } from 'node:fs';
import { extname } from 'node:path';
import * as yaml from 'js-yaml';
import { parseConfig, ShipperConfig, ConfigError } from './schema';
import { log } from '../log';

export interface LoadedConfig {
  config: ShipperConfig;
  source: 'file' | 'module-config';
  path?: string;
}

function fromModuleConfig(env: NodeJS.ProcessEnv): LoadedConfig {
  const raw: Record<string, unknown> = {};
  const copy = (k: string, cast?: (v: string) => unknown) => {
    const v = env[k];
    if (v !== undefined && v !== '') raw[k] = cast ? cast(v) : v;
  };
  copy('logLevel');
  copy('maxSize');
  copy('maxTotalSize');
  copy('strategy');
  copy('checkSeconds', Number);
  copy('intervalSeconds', Number);
  copy('maxArchives', Number);
  copy('compress', (v) => v === 'true' || v === true as unknown as string);
  copy('includeModules', (v) => v === 'true');
  // Shipping is configured through flat keys too, so `pm2 set` alone can turn it on.
  const ship: Record<string, unknown> = {};
  if (env.shipEnabled !== undefined && env.shipEnabled !== '') ship.enabled = env.shipEnabled === 'true';
  if (env.shipBackend) ship.backend = env.shipBackend;
  if (env.shipUrl) ship.url = env.shipUrl;
  if (env.shipPollSeconds) ship.pollSeconds = Number(env.shipPollSeconds);
  if (Object.keys(ship).length > 0) raw.ship = ship;

  if (env.only) raw.only = env.only.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.exclude) raw.exclude = env.exclude.split(',').map((s) => s.trim()).filter(Boolean);
  return { config: parseConfig(raw), source: 'module-config' };
}

function fromFile(path: string): LoadedConfig {
  if (!existsSync(path)) throw new ConfigError([`configFile: no such file: ${path}`]);
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = extname(path).toLowerCase() === '.json' ? JSON.parse(text) : yaml.load(text);
  } catch (e) {
    throw new ConfigError([`configFile: could not parse ${path}: ${(e as Error).message}`]);
  }
  return { config: parseConfig(raw), source: 'file', path };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const file = (env.configFile ?? '').trim();
  const loaded = file ? fromFile(file) : fromModuleConfig(env);
  log.info('configuration loaded', {
    source: loaded.source,
    path: loaded.path,
    maxSizeBytes: loaded.config.maxSize,
    maxTotalBytes: loaded.config.maxTotalSize,
    strategy: loaded.config.strategy,
  });
  return loaded;
}

export function watchConfigFile(path: string, onChange: (c: LoadedConfig) => void): FSWatcher | null {
  // Deliberately NOT fs.watch. An editor, `sed -i`, or a config-management tool writes a
  // temp file and renames it over the target, which replaces the inode. fs.watch follows
  // the inode, so it fires for that rename and is then permanently dead - verified: zero
  // events for every edit after the first. Polling identity (inode + mtime + size) is
  // slower to notice and never stops working.
  let last: string | null = null;
  const probe = (): string | null => {
    try {
      const st = statSync(path);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  };
  last = probe();

  const timer = setInterval(() => {
    const now = probe();
    if (now === null || now === last) return;
    last = now;
    try {
      onChange(fromFile(path));
      log.info('configuration reloaded', { path });
    } catch (err) {
      log.error('config reload failed, keeping previous configuration', {
        path, error: (err as Error).message,
      });
    }
  }, 2000);
  timer.unref?.();

  // Shaped like an FSWatcher so callers need not care which mechanism is used.
  return { close: () => clearInterval(timer) } as unknown as FSWatcher;
}
