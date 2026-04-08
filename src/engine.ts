import { Temporal } from "temporal-polyfill";
import type {
  Grant,
  InputData,
  TaxYearSummary,
  VestAllocation,
  Vest,
  WorkInterval,
} from "./types.ts";

/**
 * NY's allocation formula: fraction of workdays between grant and vest
 * that were spent in NY. We approximate with calendar days rather than
 * actual business days.
 */
function countDaysByLocation(
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
  workIntervals: WorkInterval[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const wi of workIntervals) {
    const overlapStart = Temporal.PlainDate.compare(wi.start, start) > 0 ? wi.start : start;
    const overlapEnd = Temporal.PlainDate.compare(wi.end, end) < 0 ? wi.end : end;

    const days = overlapStart.until(overlapEnd).total("day");
    if (days <= 0) continue;

    counts[wi.location] = (counts[wi.location] ?? 0) + days;
  }

  return counts;
}

function allocateVest(grant: Grant, vest: Vest, workIntervals: WorkInterval[]): VestAllocation {
  const daysByLocation = countDaysByLocation(grant.awardDate, vest.date, workIntervals);
  const totalDays = grant.awardDate.until(vest.date).total("day");

  const fractionByLocation: Record<string, number> = {};
  const incomeByLocation: Record<string, number> = {};
  const income = vest.shares * vest.fmvPerShare;

  for (const [loc, days] of Object.entries(daysByLocation)) {
    const frac = totalDays > 0 ? days / totalDays : 0;
    fractionByLocation[loc] = frac;
    incomeByLocation[loc] = income * frac;
  }

  return {
    grantId: grant.id,
    vestDate: vest.date,
    shares: vest.shares,
    fmvPerShare: vest.fmvPerShare,
    income,
    daysByLocation,
    totalDays,
    fractionByLocation,
    incomeByLocation,
  };
}

export function computeAllocations(input: InputData): TaxYearSummary[] {
  const byYear = new Map<number, VestAllocation[]>();

  for (const grant of input.grants) {
    for (const vest of grant.vests) {
      const alloc = allocateVest(grant, vest, input.workIntervals);
      const year = vest.date.year;
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year)!.push(alloc);
    }
  }

  const summaries: TaxYearSummary[] = [];

  for (const [taxYear, vestAllocations] of [...byYear.entries()].toSorted((a, b) => a[0] - b[0])) {
    const totalShares = vestAllocations.reduce((s, v) => s + v.shares, 0);
    const totalIncome = vestAllocations.reduce((s, v) => s + v.income, 0);
    const weightedFractionByLocation: Record<string, number> = {};
    const totalIncomeByLocation: Record<string, number> = {};

    for (const va of vestAllocations) {
      for (const [loc, frac] of Object.entries(va.fractionByLocation)) {
        const weight = totalIncome > 0 ? va.income / totalIncome : 0;
        weightedFractionByLocation[loc] = (weightedFractionByLocation[loc] ?? 0) + frac * weight;
      }
      for (const [loc, locIncome] of Object.entries(va.incomeByLocation)) {
        totalIncomeByLocation[loc] = (totalIncomeByLocation[loc] ?? 0) + locIncome;
      }
    }

    summaries.push({
      taxYear,
      vestAllocations,
      weightedFractionByLocation,
      totalShares,
      totalIncome,
      totalIncomeByLocation,
    });
  }

  return summaries;
}
