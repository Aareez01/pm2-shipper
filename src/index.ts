/**
 * pm2-shipper entry point.
 *
 * Stage one is rotation only: a replacement for pm2-logrotate that understands that in
 * cluster mode the WORKER owns the log file descriptor, so rotation is
 * rename -> reloadLogs -> verify -> compress rather than a rename. Shipping to Loki and
 * OTLP builds on the same file discovery and comes next.
 */
import { FSWatcher } from 'node:fs';
import { loadConfig, watchConfigFile } from './config/load';
import { ConfigError } from './config/schema';
import { Pm2Client } from './pm2/client';
import { Engine } from './core/engine';
import { registerMetrics } from './core/metrics';
import { log, setLogLevel } from './log';

async function main(): Promise<void> {
  const loaded = loadConfig();
  setLogLevel(loaded.config.logLevel);
  registerMetrics();

  const client = new Pm2Client();
  await client.connect();

  const engine = new Engine(client, loaded.config);
  engine.start();

  let watcher: FSWatcher | null = null;
  if (loaded.source === 'file' && loaded.path) {
    watcher = watchConfigFile(loaded.path, (next) => {
      setLogLevel(next.config.logLevel);
      engine.updateConfig(next.config);
    });
  }

  log.info('pm2-shipper started', { checkSeconds: loaded.config.checkSeconds });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    engine.stop();
    watcher?.close();
    client.disconnect();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// This module deletes files. An unhandled error here must never leave it in a state
// where it keeps running with a half-applied rotation.
process.on('unhandledRejection', (r) => log.error('unhandled rejection', { reason: String(r) }));
process.on('uncaughtException', (e) =>
  log.error('uncaught exception', { error: e.message, stack: e.stack }));

main().catch((err) => {
  if (err instanceof ConfigError) {
    log.error('startup aborted: invalid configuration', { issues: err.issues });
  } else {
    log.error('startup failed', { error: (err as Error).message });
  }
  process.exit(1);
});
