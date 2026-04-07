import { Temporal } from "temporal-polyfill";
import type { Grant, InputData, TaxYearSummary, VestAllocation, WorkInterval } from "./types.ts";

/**
 * For each day in [start, end), determine which work-location interval
 * it falls in, and accumulate a count per location.
 *
 * NY's allocation formula: fraction of workdays between grant and vest
 * that were spent in NY. We approximate by counting calendar days in
 * each declared work-location interval.
 */
function countDaysByLocation(
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
  workIntervals: WorkInterval[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const wi of workIntervals) {
    // Clamp the work interval to [start, end)
    const overlapStart = Temporal.PlainDate.compare(wi.start, start) > 0 ? wi.start : start;
    const overlapEnd = Temporal.PlainDate.compare(wi.end, end) < 0 ? wi.end : end;

    const days = overlapStart.until(overlapEnd).total("day");
    if (days <= 0) continue;

    counts[wi.location] = (counts[wi.location] ?? 0) + days;
  }

  return counts;
}

function allocateVest(
  grant: Grant,
  vestDate: Temporal.PlainDate,
  shares: number,
  workIntervals: WorkInterval[],
): VestAllocation {
  const daysByLocation = countDaysByLocation(grant.awardDate, vestDate, workIntervals);
  const totalDays = grant.awardDate.until(vestDate).total("day");

  const fractionByLocation: Record<string, number> = {};
  for (const [loc, days] of Object.entries(daysByLocation)) {
    fractionByLocation[loc] = totalDays > 0 ? days / totalDays : 0;
  }

  return {
    grantId: grant.id,
    vestDate,
    shares,
    daysByLocation,
    totalDays,
    fractionByLocation,
  };
}

export function computeAllocations(input: InputData): TaxYearSummary[] {
  const byYear = new Map<number, VestAllocation[]>();

  for (const grant of input.grants) {
    for (const vest of grant.vests) {
      const alloc = allocateVest(grant, vest.date, vest.shares, input.workIntervals);
      const year = vest.date.year;
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year)!.push(alloc);
    }
  }

  const summaries: TaxYearSummary[] = [];

  for (const [taxYear, vestAllocations] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const totalShares = vestAllocations.reduce((s, v) => s + v.shares, 0);
    const weightedFractionByLocation: Record<string, number> = {};

    for (const va of vestAllocations) {
      for (const [loc, frac] of Object.entries(va.fractionByLocation)) {
        weightedFractionByLocation[loc] =
          (weightedFractionByLocation[loc] ?? 0) + frac * (va.shares / totalShares);
      }
    }

    summaries.push({
      taxYear,
      vestAllocations,
      weightedFractionByLocation,
      totalShares,
    });
  }

  return summaries;
}
