/**
 * When to rotate. Pure, so every edge is testable without touching a disk.
 *
 * Size is checked against the file's ACTUAL size on disk rather than a running count of
 * bytes written. A byte counter drifts whenever anything else writes to the file, or
 * when the module restarts, and "max_size is ignored" is the single most reported
 * complaint against the module this replaces.
 */

export interface RotationPolicy {
  /** Rotate once the file reaches this many bytes. 0 disables the size trigger. */
  maxSizeBytes: number;
  /** Rotate at least this often, in seconds. 0 disables the time trigger. */
  intervalSeconds: number;
}

export type RotateReason = 'size' | 'interval';

export interface RotateDecision {
  rotate: boolean;
  reason?: RotateReason;
  detail?: string;
}

const NO: RotateDecision = { rotate: false };

export function shouldRotate(
  sizeBytes: number,
  lastRotatedAt: number | null,
  policy: RotationPolicy,
  now: number,
): RotateDecision {
  // Rotating an empty file produces an empty archive and resets nothing useful.
  if (sizeBytes <= 0) return NO;

  if (policy.maxSizeBytes > 0 && sizeBytes >= policy.maxSizeBytes) {
    return { rotate: true, reason: 'size',
      detail: `${sizeBytes} bytes >= ${policy.maxSizeBytes}` };
  }

  if (policy.intervalSeconds > 0) {
    // Never rotated: treat the first sighting as the start of the interval rather than
    // rotating immediately, so a module restart does not rotate every file at once.
    if (lastRotatedAt === null) return NO;
    const dueAt = lastRotatedAt + policy.intervalSeconds * 1000;
    if (now >= dueAt) {
      return { rotate: true, reason: 'interval',
        detail: `${Math.round((now - lastRotatedAt) / 1000)}s since last rotation` };
    }
  }

  return NO;
}

/** Parse "10M", "1G", "512K", or a plain byte count. Returns null when unparseable. */
export function parseSize(input: string | number | undefined | null): number | null {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
  if (!input) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([bkmgt]?)b?$/i.exec(String(input).trim());
  if (!m) return null;
  const n = parseFloat(m[1] as string);
  const unit = (m[2] ?? '').toLowerCase();
  const mult: Record<string, number> = {
    '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4,
  };
  const factor = mult[unit];
  if (factor === undefined) return null;
  return Math.floor(n * factor);
}
