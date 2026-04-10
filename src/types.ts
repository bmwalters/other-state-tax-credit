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
  end: Temporal.PlainDate;
  location: string; // ISO 3166-2 subdivision, e.g. "US-NY"
}

// ── ESPP types ──────────────────────────────────────────────────────

/** A single ESPP purchase lot acquired at the end of an offering period. */
export interface EsppPurchase {
  id: string;
  symbol: string;
  /** Start of the offering period (the "grant date" for allocation purposes). */
  offeringStartDate: Temporal.PlainDate;
  /** Date shares were purchased (end of offering period). */
  purchaseDate: Temporal.PlainDate;
  /** Price per share the employee actually paid (discounted). */
  purchasePricePerShare: number;
  /** Fair market value per share on the purchase date. */
  fmvPerShareAtPurchase: number;
  /** Total shares purchased. */
  shares: number;
}

/**
 * A sale of ESPP shares. This is the taxable event.
 *
 * For a disqualifying disposition, the ordinary income component equals
 * (FMV at purchase − purchase price) × shares sold, which is then allocated
 * to jurisdictions based on the offering period.
 */
export interface EsppSale {
  /** Which purchase lot these shares came from. */
  purchaseId: string;
  saleDate: Temporal.PlainDate;
  salePricePerShare: number;
  shares: number;
}

/** Result of allocating a single ESPP sale across work locations. */
export interface EsppSaleAllocation {
  purchaseId: string;
  saleDate: Temporal.PlainDate;
  shares: number;
  /** The ordinary income component: (FMV at purchase − purchase price) × shares. */
  ordinaryIncome: number;
  /** Discount per share: FMV at purchase − purchase price. */
  discountPerShare: number;
  /** Workday counts during the offering period, by location. */
  daysByLocation: Record<string, number>;
  /** Calendar days in the offering period (offering start → purchase date). */
  totalDays: number;
  fractionByLocation: Record<string, number>;
  ordinaryIncomeByLocation: Record<string, number>;
}

// ── Inputs & outputs ────────────────────────────────────────────────

export interface InputData {
  grants: Grant[];
  esppPurchases?: EsppPurchase[];
  esppSales?: EsppSale[];
  workIntervals: WorkInterval[];
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
  daysByLocation: Record<string, number>;
  totalDays: number;
  fractionByLocation: Record<string, number>;
  incomeByLocation: Record<string, number>;
}

export interface TaxYearSummary {
  taxYear: number;
  vestAllocations: VestAllocation[];
  esppSaleAllocations: EsppSaleAllocation[];
  /** Weighted by income, not by share count. */
  weightedFractionByLocation: Record<string, number>;
  totalShares: number;
  totalIncome: number;
  totalIncomeByLocation: Record<string, number>;
}
