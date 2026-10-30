import { Backend } from './types';
import { LogRecord } from '../record';
import { postJson } from './http';

/**
 * Grafana Loki push API.
 *
 * Loki indexes labels, not content, and every distinct label combination is a stream.
 * Labels are therefore limited to the low-cardinality facts - app, stream, host - and
 * pm_id is deliberately NOT a label: on a 16-instance cluster it would multiply the
 * stream count by sixteen for something that belongs in the line.
 */
export class LokiBackend implements Backend {
  readonly kind = 'loki';

  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly extraLabels: Record<string, string> = {},
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs = 15_000,
  ) {}

  async send(records: LogRecord[]): Promise<void> {
    const streams = new Map<string, { stream: Record<string, string>; values: string[][] }>();

    for (const r of records) {
      const labels = {
        app: r.app, stream: r.stream, host: r.host, ...this.extraLabels,
      };
      const key = JSON.stringify(labels);
      let entry = streams.get(key);
      if (!entry) {
        entry = { stream: labels, values: [] };
        streams.set(key, entry);
      }
      const line = r.pmId === null ? r.line : `[${r.pmId}] ${r.line}`;
      entry.values.push([`${r.timestamp}000000`, line]);  // Loki wants nanoseconds
    }

    // Loki rejects out-of-order entries within a stream on older versions.
    for (const s of streams.values()) s.values.sort((a, b) => Number(a[0]) - Number(b[0]));

    await postJson(
      this.url.replace(/\/+$/, '') + '/loki/api/v1/push',
      { streams: [...streams.values()] },
      this.timeoutMs,
      this.headers,
    );
  }
}
