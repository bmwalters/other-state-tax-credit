import type { Temporal } from "temporal-polyfill";

export interface Vest {
  date: Temporal.PlainDate;
  shares: number;
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

export interface Brokerage {
  canImport(filename: string, content: string): boolean;
  import(filename: string, content: string): Grant[];
}

// Engine output: a Vest enriched with the grant-to-vest day allocation by location.

export interface VestAllocation {
  grantId: string;
  vestDate: Temporal.PlainDate;
  shares: number;
  daysByLocation: Record<string, number>;
  totalDays: number;
  fractionByLocation: Record<string, number>;
}

export interface TaxYearSummary {
  taxYear: number;
  vestAllocations: VestAllocation[];
  /** Aggregated fraction across all vests, weighted by shares */
  weightedFractionByLocation: Record<string, number>;
  totalShares: number;
}
