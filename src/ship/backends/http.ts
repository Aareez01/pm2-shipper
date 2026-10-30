import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { DeliveryError } from './types';

export function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch {
      return reject(new DeliveryError(`invalid url: ${url}`, false));
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (text.length < 4096) text += c; });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) return resolve();
        // 4xx other than 429 will fail identically forever: retrying only stalls the
        // offset and blocks every later line behind a batch that can never succeed.
        reject(new DeliveryError(
          `HTTP ${status}: ${text.slice(0, 200)}`,
          status === 429 || status >= 500,
        ));
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new DeliveryError('timeout', true)); });
    req.on('error', (e) => reject(new DeliveryError(e.message, true)));
    req.end(payload);
  });
}
