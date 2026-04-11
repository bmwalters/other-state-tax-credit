import { Temporal } from "temporal-polyfill";
import type {
  DomicileInterval,
  NonWorkingInterval,
  ReportingEvent,
  StatutoryResidence,
  WorkInterval,
} from "./types.ts";
import { isWeekday } from "./workdays.ts";

// ── No-income-tax states ────────────────────────────────────────────

/**
 * US states (ISO 3166-2) that do not levy a personal income tax on wages.
 *
 * New Hampshire and Washington tax only investment income (dividends/interest
 * and capital gains respectively), not earned income, so they are included
 * here — earned income (salary, RSU vests, ESPP ordinary income) is not
 * taxed by those states.
 *
 * Tennessee fully repealed its Hall income tax effective 2021.
 */
export const NO_INCOME_TAX_STATES: ReadonlySet<string> = new Set([
  "US-AK", // Alaska
  "US-FL", // Florida
  "US-NV", // Nevada
  "US-NH", // New Hampshire (no tax on earned income)
  "US-SD", // South Dakota
  "US-TN", // Tennessee
  "US-TX", // Texas
  "US-WA", // Washington (no tax on earned income)
  "US-WY", // Wyoming
]);

// ── State rules configuration ───────────────────────────────────────

export interface StateRulesConfig {
  domicileIntervals: DomicileInterval[];
  statutoryResidences: StatutoryResidence[];
  reportingEvents: ReportingEvent[];
  /**
   * Pre-computed: per-year work-day counts by physical location.
   * Used for the de minimis check (<10 days + no reporting event → suppress).
   */
  yearlyDayCounts: ReadonlyMap<number, Readonly<Record<string, number>>>;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Pre-compute per-calendar-year work-day counts by physical location.
 *
 * This scans ALL work intervals (not windowed) so that the de minimis
 * threshold is evaluated against the full year, independent of any
 * particular allocation window.
 */
export function computeYearlyDayCounts(
  workIntervals: WorkInterval[],
  nonWorkingIntervals: NonWorkingInterval[],
): Map<number, Record<string, number>> {
  // Build non-working set across all years spanned by work intervals.
  if (workIntervals.length === 0) return new Map();

  let minYear = Infinity;
  let maxYear = -Infinity;
  for (const wi of workIntervals) {
    minYear = Math.min(minYear, wi.start.year);
    maxYear = Math.max(maxYear, wi.end.year);
  }

  const nonWorkingDays = new Set<string>();
  for (const nw of nonWorkingIntervals) {
    let cursor = nw.start;
    while (Temporal.PlainDate.compare(cursor, nw.end) <= 0) {
      if (isWeekday(cursor)) nonWorkingDays.add(cursor.toString());
      cursor = cursor.add({ days: 1 });
    }
  }

  const result = new Map<number, Record<string, number>>();
  for (let year = minYear; year <= maxYear; year++) {
    result.set(year, {});
  }

  for (const wi of workIntervals) {
    let cursor = wi.start;
    while (Temporal.PlainDate.compare(cursor, wi.end) <= 0) {
      if (isWeekday(cursor) && !nonWorkingDays.has(cursor.toString())) {
        const yearCounts = result.get(cursor.year)!;
        yearCounts[wi.location] = (yearCounts[wi.location] ?? 0) + 1;
      }
      cursor = cursor.add({ days: 1 });
    }
  }

  return result;
}

/** Build a Set of reporting-event states for a given year. */
function reportingStatesForYear(reportingEvents: ReportingEvent[], year: number): Set<string> {
  const set = new Set<string>();
  for (const re of reportingEvents) {
    if (re.year === year) set.add(re.state);
  }
  return set;
}

/**
 * True if a state levies no personal income tax on earned income.
 * These are always suppressed — you cannot file there regardless.
 */
export function isNoIncomeTaxState(location: string): boolean {
  return NO_INCOME_TAX_STATES.has(location);
}

/**
 * True if a physical work location qualifies for de minimis treatment
 * in a given year: fewer than 10 work days AND no reporting event filed.
 *
 * De minimis locations are *candidates* for suppression, but whether
 * suppression actually occurs depends on the number of residence states
 * claiming the income — see `resolveClaimingStates`.
 */
export function isDeMinimis(location: string, year: number, config: StateRulesConfig): boolean {
  if (NO_INCOME_TAX_STATES.has(location)) return false; // handled separately

  const yearCounts = config.yearlyDayCounts.get(year);
  const dayCount = yearCounts?.[location] ?? 0;
  if (dayCount >= 10) return false;

  const reportingStates = reportingStatesForYear(config.reportingEvents, year);
  return !reportingStates.has(location);
}

// ── Day resolution ──────────────────────────────────────────────────

/**
 * Get the domicile state for a given date, or undefined if no domicile
 * interval covers it.
 */
export function getDomicileState(
  date: Temporal.PlainDate,
  domicileIntervals: DomicileInterval[],
): string | undefined {
  for (const di of domicileIntervals) {
    if (
      Temporal.PlainDate.compare(date, di.start) >= 0 &&
      Temporal.PlainDate.compare(date, di.end) <= 0
    ) {
      return di.state;
    }
  }
  return undefined;
}

/**
 * Get statutory-residence states for a given year.
 */
export function getStatutoryResidenceStates(
  year: number,
  statutoryResidences: StatutoryResidence[],
): string[] {
  return statutoryResidences.filter((sr) => sr.year === year).map((sr) => sr.state);
}

/**
 * Resolve the set of claiming states for a single working day.
 *
 * Every day's income is claimed by the union of:
 * - The domicile state on that date (if any)
 * - All statutory-residence states for that year
 * - The physical work location — with two exceptions:
 *
 *   1. **No-income-tax states** (TX, FL, …) are always excluded — you
 *      cannot file a return there regardless.
 *
 *   2. **De minimis states** (<10 days, no reporting event) are excluded
 *      only when a single residence state would otherwise claim the
 *      income. When *multiple* residence states claim the same income
 *      (domicile ≠ statutory residence), keeping the de minimis state
 *      lets the taxpayer file there and obtain credits to offset the
 *      otherwise unrelieved double taxation between residence states.
 *
 * Returns a deduplicated array of state codes.
 */
export function resolveClaimingStates(
  date: Temporal.PlainDate,
  physicalLocation: string | undefined,
  config: StateRulesConfig,
): string[] {
  // 1. Compute residence states (domicile + statutory residence).
  const residenceStates = new Set<string>();
  const domicile = getDomicileState(date, config.domicileIntervals);
  if (domicile) residenceStates.add(domicile);
  for (const sr of getStatutoryResidenceStates(date.year, config.statutoryResidences)) {
    residenceStates.add(sr);
  }

  // 2. Determine whether the physical location contributes.
  const states = new Set<string>(residenceStates);

  if (physicalLocation) {
    if (isNoIncomeTaxState(physicalLocation)) {
      // Always suppress — can't file there.
    } else if (isDeMinimis(physicalLocation, date.year, config)) {
      // Suppress only when ≤1 residence state claims the income.
      // With multiple residence states, keeping the de minimis state
      // provides a credit opportunity to offset double taxation.
      if (residenceStates.size > 1) {
        states.add(physicalLocation);
      }
    } else {
      states.add(physicalLocation);
    }
  }

  return [...states];
}

/**
 * Build a StateRulesConfig from InputData fields.
 */
export function buildStateRulesConfig(
  workIntervals: WorkInterval[],
  nonWorkingIntervals: NonWorkingInterval[],
  domicileIntervals: DomicileInterval[],
  statutoryResidences: StatutoryResidence[],
  reportingEvents: ReportingEvent[],
): StateRulesConfig {
  return {
    domicileIntervals,
    statutoryResidences,
    reportingEvents,
    yearlyDayCounts: computeYearlyDayCounts(workIntervals, nonWorkingIntervals),
  };
}
