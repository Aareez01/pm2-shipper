/**
 * What to delete. Pure.
 *
 * The cap is a BYTE BUDGET, not a file count. A file count does not bound disk usage:
 * keeping 30 archives is meaningless if each one is a gigabyte, and that is exactly how
 * a log rotator ends up filling the disk it was installed to protect. A file count is
 * supported as an additional limit, never as the only one.
 */

export interface Archive {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface RetentionLimits {
  /** Total bytes of archives to keep per log file. 0 disables the byte cap. */
  maxTotalBytes: number;
  /** Maximum number of archives to keep. 0 disables the count cap. */
  maxArchives: number;
}

export interface RetentionPlan {
  keep: Archive[];
  remove: Archive[];
  bytesFreed: number;
  /** True when the byte cap forced a deletion, which is worth saying out loud. */
  cappedByBytes: boolean;
}

export function planRetention(archives: Archive[], limits: RetentionLimits): RetentionPlan {
  // Newest first, so "drop the tail" means "drop the oldest".
  const sorted = [...archives].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep: Archive[] = [];
  const remove: Archive[] = [];
  let total = 0;
  let cappedByBytes = false;

  for (const a of sorted) {
    const overCount = limits.maxArchives > 0 && keep.length >= limits.maxArchives;
    const overBytes =
      limits.maxTotalBytes > 0 && total + a.sizeBytes > limits.maxTotalBytes;

    if (overCount || overBytes) {
      if (overBytes && !overCount) cappedByBytes = true;
      remove.push(a);
      continue;
    }
    keep.push(a);
    total += a.sizeBytes;
  }

  return {
    keep,
    remove,
    bytesFreed: remove.reduce((n, a) => n + a.sizeBytes, 0),
    cappedByBytes,
  };
}
