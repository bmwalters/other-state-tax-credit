import { Temporal } from "temporal-polyfill";
import type { NonWorkingInterval, WorkInterval } from "./types.ts";

/**
 * Returns true if the given date is a weekday (Mon–Fri).
 * Temporal.PlainDate.dayOfWeek: 1=Mon … 7=Sun.
 */
export function isWeekday(date: Temporal.PlainDate): boolean {
  return date.dayOfWeek <= 5;
}

/**
 * Build a Set of ISO date strings for all weekdays inside the given
 * non-working intervals that fall within [windowStart, windowEnd] (inclusive).
 */
function buildNonWorkingSet(
  nonWorkingIntervals: NonWorkingInterval[],
  windowStart: Temporal.PlainDate,
  windowEnd: Temporal.PlainDate,
): Set<string> {
  const set = new Set<string>();
  for (const nw of nonWorkingIntervals) {
    const start = Temporal.PlainDate.compare(nw.start, windowStart) > 0 ? nw.start : windowStart;
    const end = Temporal.PlainDate.compare(nw.end, windowEnd) < 0 ? nw.end : windowEnd;
    if (Temporal.PlainDate.compare(start, end) > 0) continue;

    let cursor = start;
    while (Temporal.PlainDate.compare(cursor, end) <= 0) {
      if (isWeekday(cursor)) {
        set.add(cursor.toString());
      }
      cursor = cursor.add({ days: 1 });
    }
  }
  return set;
}

/**
 * Count working days in the inclusive range [start, end], excluding
 * weekends and any dates in `nonWorkingDays`.
 */
export function countWorkingDays(
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
  nonWorkingDays: Set<string>,
): number {
  let count = 0;
  let cursor = start;
  while (Temporal.PlainDate.compare(cursor, end) <= 0) {
    if (isWeekday(cursor) && !nonWorkingDays.has(cursor.toString())) {
      count++;
    }
    cursor = cursor.add({ days: 1 });
  }
  return count;
}

export interface WorkingDayAllocation {
  /** Working days per location within the allocation window. */
  daysByLocation: Record<string, number>;
  /** Total working days in the allocation window (the denominator). */
  totalWorkingDays: number;
}

/**
 * Validate work intervals and count working days per location within the
 * inclusive allocation window [start, end].
 *
 * Implements the §132.18(a) working-day formula:
 * - Weekends (Sat/Sun) are excluded.
 * - Non-working intervals (holidays, vacation, sick, leave) are excluded.
 * - Remaining uncovered weekdays are treated as non-NY days.
 *
 * Throws on overlapping work intervals.
 */
export function countWorkingDaysByLocation(
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
  workIntervals: WorkInterval[],
  nonWorkingIntervals: NonWorkingInterval[],
): WorkingDayAllocation {
  const nonWorkingDays = buildNonWorkingSet(nonWorkingIntervals, start, end);

  // Sort work intervals by start date for deterministic overlap detection
  const sorted = [...workIntervals]
    .filter((wi) => {
      // Only keep intervals that overlap the allocation window
      return (
        Temporal.PlainDate.compare(wi.start, end) <= 0 &&
        Temporal.PlainDate.compare(wi.end, start) >= 0
      );
    })
    .sort((a, b) => Temporal.PlainDate.compare(a.start, b.start));

  // Build a day → location map for every working day in the window
  const dayLocation = new Map<string, string>();

  for (const wi of sorted) {
    const overlapStart = Temporal.PlainDate.compare(wi.start, start) > 0 ? wi.start : start;
    const overlapEnd = Temporal.PlainDate.compare(wi.end, end) < 0 ? wi.end : end;

    let cursor = overlapStart;
    while (Temporal.PlainDate.compare(cursor, overlapEnd) <= 0) {
      if (isWeekday(cursor) && !nonWorkingDays.has(cursor.toString())) {
        const key = cursor.toString();
        if (dayLocation.has(key)) {
          throw new Error(
            `Overlapping work intervals: ${key} is claimed by both "${dayLocation.get(key)}" and "${wi.location}"`,
          );
        }
        dayLocation.set(key, wi.location);
      }
      cursor = cursor.add({ days: 1 });
    }
  }

  let totalWorkingDays = 0;
  let cursor = start;
  while (Temporal.PlainDate.compare(cursor, end) <= 0) {
    if (isWeekday(cursor) && !nonWorkingDays.has(cursor.toString())) {
      totalWorkingDays++;
    }
    cursor = cursor.add({ days: 1 });
  }

  // Aggregate by location
  const daysByLocation: Record<string, number> = {};
  for (const loc of dayLocation.values()) {
    daysByLocation[loc] = (daysByLocation[loc] ?? 0) + 1;
  }

  return { daysByLocation, totalWorkingDays };
}
