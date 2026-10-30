/** Internal counters, published through @pm2/io when it is available. */
export const counters = {
  filesWatched: 0,
  rotations: 0,
  rotationFailures: 0,
  reopenFailures: 0,
  archivesCompressed: 0,
  archivesDeleted: 0,
  bytesRotated: 0,
  bytesFreed: 0,
  bytesDroppedToCap: 0,
  appsUnrotatable: 0,

  linesShipped: 0,
  bytesShipped: 0,
  deliveryFailures: 0,
  /** Bytes behind the end of the files being followed - the headline number. */
  shippingLagBytes: 0,
};

export type CounterName = keyof typeof counters;
export function inc(n: CounterName, by = 1): void { counters[n] += by; }
export function set(n: CounterName, v: number): void { counters[n] = v; }

export function registerMetrics(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const io = require('@pm2/io');
    for (const k of Object.keys(counters) as CounterName[]) {
      io.metric({ name: `shipper.${k}`, value: () => counters[k] });
    }
  } catch { /* optional */ }
}
