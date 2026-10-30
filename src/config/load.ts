import { readFileSync, existsSync, watch, FSWatcher } from 'node:fs';
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
  try {
    let timer: NodeJS.Timeout | null = null;
    return watch(path, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          onChange(fromFile(path));
          log.info('configuration reloaded', { path });
        } catch (err) {
          log.error('config reload failed, keeping previous configuration', {
            path, error: (err as Error).message });
        }
      }, 1000);
    });
  } catch (err) {
    log.warn('could not watch config file', { path, error: (err as Error).message });
    return null;
  }
}
