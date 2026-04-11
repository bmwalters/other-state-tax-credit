import type { Temporal } from "temporal-polyfill";

export interface Vest {
  date: Temporal.PlainDate;
  shares: number;
  fmvPerShare: number;
}

export interface Grant {
  id: string;
  awardDate: Temporal.PlainDate;
  symbol: string;
  vests: Vest[];
}

export interface WorkInterval {
  start: Temporal.PlainDate;
  /** Inclusive end date. */
  end: Temporal.PlainDate;
  location: string; // ISO 3166-2 subdivision, e.g. "US-NY"
}

/** A period when no work was performed (holiday, vacation, sick, leave, etc.). */
export interface NonWorkingInterval {
  start: Temporal.PlainDate;
  /** Inclusive end date. */
  end: Temporal.PlainDate;
  category: string; // e.g. "holiday", "vacation", "sick", "leave"
}

// ── ESPP types ──────────────────────────────────────────────────────

/** A single ESPP purchase lot acquired at the end of an offering period. */
export interface EsppPurchase {
  id: string;
  symbol: string;
  /** Start of the offering period (the "grant date" for allocation purposes). */
  offeringStartDate: Temporal.PlainDate;
  /** Fair market value per share on the offering start / grant date. */
  fmvPerShareAtGrant: number;
  /** Date shares were purchased (end of offering period). */
  purchaseDate: Temporal.PlainDate;
  /** Price per share the employee actually paid (discounted). */
  purchasePricePerShare: number;
  /** Fair market value per share on the purchase date. */
  fmvPerShareAtPurchase: number;
  /** Total shares purchased. */
  shares: number;
}

export type EsppDispositionType = "QUALIFIED" | "DISQUALIFIED";

/**
 * A sale of ESPP shares. This is the taxable event.
 */
export interface EsppSale {
  /** Which purchase lot these shares came from. */
  purchaseId: string;
  saleDate: Temporal.PlainDate;
  salePricePerShare: number;
  shares: number;
  /** Schwab disposition label, preserved for auditability. */
  dispositionType: EsppDispositionType;
}

/** Result of allocating a single ESPP sale across work locations. */
export interface EsppSaleAllocation {
  purchaseId: string;
  saleDate: Temporal.PlainDate;
  shares: number;
  /** Schwab disposition label, preserved for auditability. */
  dispositionType: EsppDispositionType;
  /**
   * The New York compensation component for a statutory-option/ESPP sale.
   *
   * QUALIFIED: lesser of actual gain and grant-date discount.
   * DISQUALIFIED: lesser of actual gain and purchase-date discount.
   */
  ordinaryIncome: number;
  /** Discount per share: FMV at purchase − purchase price. */
  discountPerShare: number;
  /**
   * Working-day counts during the offering period, by claiming state.
   *
   * A single day may appear in multiple state buckets (domicile, statutory
   * residence, and/or non-resident sourcing state), so values may sum to
   * more than totalDays.
   */
  daysByLocation: Record<string, number>;
  /** Total working days in the offering period (offering start → purchase date, inclusive). */
  totalDays: number;
  fractionByLocation: Record<string, number>;
  ordinaryIncomeByLocation: Record<string, number>;
}

/**
 * Calendar-year working-day allocation for salary sourcing.
 *
 * Per 20 NYCRR §132.18(a), salary is allocated to NY based on:
 *   NY salary = total compensation × (NY working days / total working days)
 * where non-working days (weekends, holidays, vacation, sick, leave) are
 * excluded from both numerator and denominator.
 *
 * With state rules applied, a single day may be claimed by multiple states,
 * so fractions may sum to more than 1.0.
 */
export interface SalaryAllocation {
  year: number;
  daysByLocation: Record<string, number>;
  totalDays: number;
  fractionByLocation: Record<string, number>;
}

// ── State tax rules ─────────────────────────────────────────────────

/**
 * A reporting event records that a state had taxable income reported in a
 * given year (e.g. a W-2 or 1099 was filed listing that state).
 */
export interface ReportingEvent {
  year: number;
  /** ISO 3166-2 subdivision, e.g. "US-NY". */
  state: string;
}

/**
 * A period of domicile in a state.
 *
 * The taxpayer is treated as a resident of this state for the duration of
 * the interval. All income earned during this period — regardless of where
 * the work was physically performed — is taxable by this state.
 */
export interface DomicileInterval {
  start: Temporal.PlainDate;
  /** Inclusive end date. */
  end: Temporal.PlainDate;
  /** ISO 3166-2 subdivision, e.g. "US-NY". */
  state: string;
}

/**
 * Statutory residence triggered for a full tax year.
 *
 * If a state's statutory-residence test is met (e.g. 183-day + permanent
 * place of abode), all income for that year is taxable by this state,
 * regardless of sourcing.
 */
export interface StatutoryResidence {
  year: number;
  /** ISO 3166-2 subdivision, e.g. "US-NY". */
  state: string;
}

// ── Inputs & outputs ────────────────────────────────────────────────

export interface InputData {
  grants: Grant[];
  esppPurchases?: EsppPurchase[];
  esppSales?: EsppSale[];
  workIntervals: WorkInterval[];
  /** Days off (holidays, vacation, sick, leave). Weekdays in these intervals are excluded from both numerator and denominator. */
  nonWorkingIntervals: NonWorkingInterval[];
  /** Per-year reporting events — states where income was reported on a W-2 or 1099. */
  reportingEvents: ReportingEvent[];
  /** Periods of domicile in each state. */
  domicileIntervals: DomicileInterval[];
  /** States where statutory residence was triggered for a full year. */
  statutoryResidences: StatutoryResidence[];
}

export type FileMap = ReadonlyMap<string, string>;

export interface BrokerageResult {
  grants: Grant[];
  esppPurchases?: EsppPurchase[];
  esppSales?: EsppSale[];
}

export interface Brokerage {
  canImport(files: FileMap): boolean;
  import(files: FileMap): BrokerageResult;
}

export interface VestAllocation {
  grantId: string;
  vestDate: Temporal.PlainDate;
  shares: number;
  fmvPerShare: number;
  income: number;
  /**
   * Working-day counts by claiming state. A single day may appear in
   * multiple state buckets, so values may sum to more than totalDays.
   */
  daysByLocation: Record<string, number>;
  totalDays: number;
  fractionByLocation: Record<string, number>;
  incomeByLocation: Record<string, number>;
}

export interface TaxYearSummary {
  taxYear: number;
  vestAllocations: VestAllocation[];
  esppSaleAllocations: EsppSaleAllocation[];
  /** Weighted by income, not by share count. Fractions may sum to >1.0. */
  weightedFractionByLocation: Record<string, number>;
  totalShares: number;
  totalIncome: number;
  totalIncomeByLocation: Record<string, number>;
}
