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

export interface InputData {
  grants: Grant[];
  workIntervals: WorkInterval[];
}

export type FileMap = ReadonlyMap<string, string>;

export interface Brokerage {
  canImport(files: FileMap): boolean;
  import(files: FileMap): Grant[];
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
  /** Weighted by income, not by share count. */
  weightedFractionByLocation: Record<string, number>;
  totalShares: number;
  totalIncome: number;
  totalIncomeByLocation: Record<string, number>;
}
