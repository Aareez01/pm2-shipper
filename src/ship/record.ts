import { LogTarget } from '../rotate/discover';

/** One shippable line, enriched with everything a query will need. */
export interface LogRecord {
  timestamp: number;
  app: string;
  pmId: number | null;
  stream: 'out' | 'err';
  host: string;
  line: string;
  /** Present when the line was itself JSON. */
  fields?: Record<string, unknown>;
}

/** PM2 prefixes lines with a date when log_date_format is set; keep it out of the body. */
const PM2_DATE = /^(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?):\s/;

export function toRecord(
  line: string,
  target: LogTarget,
  host: string,
  now: number = Date.now(),
): LogRecord {
  let body = line;
  let timestamp = now;

  const m = PM2_DATE.exec(line);
  if (m) {
    const parsed = Date.parse(m[1] as string);
    if (Number.isFinite(parsed)) {
      timestamp = parsed;
      body = line.slice(m[0].length);
    }
  }

  const rec: LogRecord = {
    timestamp,
    app: target.app,
    // Under merge_logs several instances share a file, so no single pm_id is truthful.
    pmId: target.merged || target.pmIds.length !== 1 ? null : (target.pmIds[0] as number),
    stream: target.stream,
    host,
    line: body,
  };

  const trimmed = body.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rec.fields = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON after all - ship it as a message, which is what it is.
    }
  }

  return rec;
}
