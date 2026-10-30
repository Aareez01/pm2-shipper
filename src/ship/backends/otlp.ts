import { Backend } from './types';
import { LogRecord } from '../record';
import { postJson } from './http';

const SEVERITY = { out: { number: 9, text: 'INFO' }, err: { number: 17, text: 'ERROR' } };

function attr(key: string, value: string | number | null) {
  if (value === null) return null;
  return typeof value === 'number'
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: value } };
}

/**
 * OTLP/HTTP logs.
 *
 * This is also the route to CloudWatch, Datadog and most other sinks: the OpenTelemetry
 * Collector already exports to them, so one hop of standard infrastructure covers what
 * would otherwise be a native integration and a credential chain per vendor.
 */
export class OtlpBackend implements Backend {
  readonly kind = 'otlp';

  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly resourceAttributes: Record<string, string> = {},
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs = 15_000,
  ) {}

  async send(records: LogRecord[]): Promise<void> {
    const byApp = new Map<string, LogRecord[]>();
    for (const r of records) {
      const arr = byApp.get(r.app) ?? [];
      arr.push(r);
      byApp.set(r.app, arr);
    }

    const resourceLogs = [...byApp.entries()].map(([app, recs]) => ({
      resource: {
        attributes: [
          attr('service.name', app),
          attr('host.name', recs[0]!.host),
          ...Object.entries(this.resourceAttributes).map(([k, v]) => attr(k, v)),
        ].filter(Boolean),
      },
      scopeLogs: [{
        scope: { name: 'pm2-shipper' },
        logRecords: recs.map((r) => ({
          timeUnixNano: `${r.timestamp}000000`,
          severityNumber: SEVERITY[r.stream].number,
          severityText: SEVERITY[r.stream].text,
          body: { stringValue: r.line },
          attributes: [
            attr('pm2.stream', r.stream),
            attr('pm2.pm_id', r.pmId),
            ...(r.fields
              ? Object.entries(r.fields).slice(0, 32).map(([k, v]) =>
                  attr(`log.${k}`, typeof v === 'number' ? v : String(v)))
              : []),
          ].filter(Boolean),
        })),
      }],
    }));

    await postJson(
      this.url.replace(/\/+$/, '') + '/v1/logs',
      { resourceLogs },
      this.timeoutMs,
      this.headers,
    );
  }
}
