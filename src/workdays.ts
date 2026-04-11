import { Temporal } from "temporal-polyfill";
import type { NonWorkingInterval, WorkInterval } from "./types.ts";
import type { StateRulesConfig } from "./state-rules.ts";
import { resolveClaimingStates } from "./state-rules.ts";

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

export interface WorkingDayAllocation {
  /**
   * Working days per claiming state within the allocation window.
   *
   * A single day may be claimed by multiple states (domicile, statutory
   * residence, non-resident sourcing), so the sum of values may exceed
   * totalWorkingDays.
   */
  daysByLocation: Record<string, number>;
  /** Total working days in the allocation window (the denominator). */
  totalWorkingDays: number;
}

/**
 * Build a map of date → physical work location for every working day in
 * the allocation window [start, end] (inclusive).
 *
 * Throws on overlapping work intervals.
 */
function buildDayLocationMap(
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
  workIntervals: WorkInterval[],
  nonWorkingDays: Set<string>,
): Map<string, string> {
  const sorted = [...workIntervals]
    .filter((wi) => {
      return (
        Temporal.PlainDate.compare(wi.start, end) <= 0 &&
        Temporal.PlainDate.compare(wi.end, start) >= 0
      );
    })
    .sort((a, b) => Temporal.PlainDate.compare(a.start, b.start));

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

  return dayLocation;
}

/**
 * Validate work intervals and count working days per claiming state
 * within the inclusive allocation window [start, end].
 *
 * Each day is resolved through state rules to the union of claiming
 * states (domicile, statutory residence, and/or non-resident physical
 * location). A single day may appear in multiple state buckets.
 *
 * Throws on overlapping work intervals.
 */
export function countWorkingDaysByLocation(
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
  workIntervals: WorkInterval[],
  nonWorkingIntervals: NonWorkingInterval[],
  stateRulesConfig: StateRulesConfig,
): WorkingDayAllocation {
  const nonWorkingDays = buildNonWorkingSet(nonWorkingIntervals, start, end);
  const dayLocation = buildDayLocationMap(start, end, workIntervals, nonWorkingDays);

  const daysByLocation: Record<string, number> = {};
  let totalWorkingDays = 0;

  let cursor = start;
  while (Temporal.PlainDate.compare(cursor, end) <= 0) {
    const key = cursor.toString();
    if (isWeekday(cursor) && !nonWorkingDays.has(key)) {
      totalWorkingDays++;
      const physicalLocation = dayLocation.get(key);
      const claimingStates = resolveClaimingStates(cursor, physicalLocation, stateRulesConfig);
      for (const state of claimingStates) {
        daysByLocation[state] = (daysByLocation[state] ?? 0) + 1;
      }
    }
    cursor = cursor.add({ days: 1 });
  }

  return { daysByLocation, totalWorkingDays };
}
