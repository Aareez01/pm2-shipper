import { Pm2Process } from './types';
import { log } from '../log';

/**
 * Thin promisified wrapper over the `pm2` package.
 *
 * `reloadLogs` is the important one: it is what makes every cluster worker close and
 * reopen its log streams. Without it a rotation is just a rename, and the workers keep
 * appending to the inode that is no longer in the directory.
 */
interface Pm2Api {
  connect(cb: (err: Error | null) => void): void;
  disconnect(): void;
  list(cb: (err: Error | null, list: Pm2Process[]) => void): void;
  reloadLogs(cb: (err: Error | null) => void): void;
}

function resolvePm2(): Pm2Api {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('pm2') as Pm2Api;
  } catch (err) {
    throw new Error(
      'could not require("pm2"). pm2-shipper is a PM2 module and needs the pm2 package ' +
        'resolvable from its install directory. Original error: ' + (err as Error).message,
    );
  }
}

export class Pm2Client {
  private api: Pm2Api | null = null;

  async connect(): Promise<void> {
    const api = resolvePm2();
    await new Promise<void>((res, rej) => api.connect((e) => (e ? rej(e) : res())));
    this.api = api;
  }

  disconnect(): void {
    try { this.api?.disconnect(); } catch { /* shutting down */ }
  }

  async list(): Promise<Pm2Process[]> {
    const api = this.require();
    return new Promise((res, rej) => api.list((e, l) => (e ? rej(e) : res(l ?? []))));
  }

  /** Tell the daemon and every cluster worker to reopen their log files. */
  async reloadLogs(): Promise<boolean> {
    const api = this.require();
    return new Promise((res) =>
      api.reloadLogs((err) => {
        if (err) {
          log.error('reloadLogs failed - workers may still hold the old file', {
            error: err.message,
          });
          return res(false);
        }
        res(true);
      }),
    );
  }

  private require(): Pm2Api {
    if (!this.api) throw new Error('pm2 client not connected');
    return this.api;
  }
}
