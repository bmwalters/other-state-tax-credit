import { Temporal } from "temporal-polyfill";

function isDuration(s: string) {
  return /^[+-]?P/i.test(s);
}

/**
 * Parse an ISO 8601 interval string into a start/end PlainDate pair.
 *
 * Supports four forms:
 *   - date            e.g. "2024-01-01"          (single-day interval)
 *   - date/date       e.g. "2024-01-01/2024-07-01"
 *   - date/duration   e.g. "2024-01-01/P6M"
 *   - duration/date   e.g. "P6M/2024-07-01"
 */
export function parseInterval(interval: string): {
  start: Temporal.PlainDate;
  end: Temporal.PlainDate;
} {
  const slash = interval.indexOf("/");
  if (slash === -1) {
    // Single-date interval: start === end
    const date = Temporal.PlainDate.from(interval);
    return { start: date, end: date };
  }
  const lhs = interval.slice(0, slash);
  const rhs = interval.slice(slash + 1);
  if (!lhs || !rhs) {
    throw new Error(`malformed interval: ${interval}`);
  }

  if (isDuration(lhs) && isDuration(rhs)) {
    throw new Error(`malformed interval (both sides are durations): ${interval}`);
  }

  if (isDuration(lhs)) {
    // duration/date
    const end = Temporal.PlainDate.from(rhs);
    const dur = Temporal.Duration.from(lhs);
    const start = end.subtract(dur);
    return { start, end };
  }

  if (isDuration(rhs)) {
    // date/duration
    const start = Temporal.PlainDate.from(lhs);
    const dur = Temporal.Duration.from(rhs);
    const end = start.add(dur);
    return { start, end };
  }

  // date/date
  return {
    start: Temporal.PlainDate.from(lhs),
    end: Temporal.PlainDate.from(rhs),
  };
}
