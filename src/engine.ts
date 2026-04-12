import { Temporal } from "temporal-polyfill";
import type {
  EsppPurchase,
  EsppSale,
  EsppSaleAllocation,
  Grant,
  InputData,
  NonWorkingInterval,
  SalaryAllocation,
  TaxYearSummary,
  VestAllocation,
  Vest,
  WorkInterval,
} from "./types.ts";
import { countWorkingDaysByLocation } from "./workdays.ts";
import {
  buildStateRulesConfig,
  getResidentStates,
  resolveNonresidentSourceStates,
  type StateRulesConfig,
} from "./state-rules.ts";

function allocateVest(
  grant: Grant,
  vest: Vest,
  workIntervals: WorkInterval[],
  nonWorkingIntervals: NonWorkingInterval[],
  stateRulesConfig: StateRulesConfig,
): VestAllocation {
  // 1. Count working days by nonresident source state only (physical
  //    location, with no-income-tax and de minimis filtering).
  const { daysByLocation, totalWorkingDays } = countWorkingDaysByLocation(
    grant.awardDate,
    vest.date,
    workIntervals,
    nonWorkingIntervals,
    stateRulesConfig,
    resolveNonresidentSourceStates,
  );

  // 2. Apply resident override: states where the taxpayer is domiciled
  //    or a statutory resident at the vest date (the income recognition
  //    date) claim 100% of the income — the "worldwide income" rule.
  //    (FTB Pub. 1100 §D–E; Example 14)
  for (const state of getResidentStates(vest.date, stateRulesConfig)) {
    daysByLocation[state] = totalWorkingDays;
  }

  const fractionByLocation: Record<string, number> = {};
  const incomeByLocation: Record<string, number> = {};
  const income = vest.shares * vest.fmvPerShare;

  for (const [loc, days] of Object.entries(daysByLocation)) {
    const frac = totalWorkingDays > 0 ? days / totalWorkingDays : 0;
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
    totalDays: totalWorkingDays,
    fractionByLocation,
    incomeByLocation,
  };
}

/**
 * Allocate the ordinary income from an ESPP sale across work locations.
 *
 * The allocation period is the offering period (offering start → purchase date),
 * NOT the period up to the sale date. The taxable event occurs on the sale date
 * and falls into that sale's tax year.
 *
 * The ordinary-income formula depends on the provided disposition type:
 * - QUALIFIED: lesser of actual gain and grant-date discount
 * - DISQUALIFIED: lesser of actual gain and purchase-date discount
 */
function computeEsppOrdinaryIncome(purchase: EsppPurchase, sale: EsppSale): number {
  const actualGainPerShare = Math.max(0, sale.salePricePerShare - purchase.purchasePricePerShare);
  const grantDateDiscountPerShare = Math.max(
    0,
    purchase.fmvPerShareAtGrant - purchase.purchasePricePerShare,
  );
  const purchaseDateDiscountPerShare = Math.max(
    0,
    purchase.fmvPerShareAtPurchase - purchase.purchasePricePerShare,
  );

  let compensationPerShare: number;
  switch (sale.dispositionType) {
    case "QUALIFIED":
      compensationPerShare = Math.min(actualGainPerShare, grantDateDiscountPerShare);
      break;
    case "DISQUALIFIED":
      compensationPerShare = Math.min(actualGainPerShare, purchaseDateDiscountPerShare);
      break;
  }

  return compensationPerShare * sale.shares;
}

function allocateEsppSale(
  purchase: EsppPurchase,
  sale: EsppSale,
  workIntervals: WorkInterval[],
  nonWorkingIntervals: NonWorkingInterval[],
  stateRulesConfig: StateRulesConfig,
): EsppSaleAllocation {
  // 1. Count working days by nonresident source state only.
  const { daysByLocation, totalWorkingDays } = countWorkingDaysByLocation(
    purchase.offeringStartDate,
    purchase.purchaseDate,
    workIntervals,
    nonWorkingIntervals,
    stateRulesConfig,
    resolveNonresidentSourceStates,
  );

  // 2. Apply resident override at the sale date (the recognition date
  //    for ESPP ordinary income). Resident states claim 100%.
  for (const state of getResidentStates(sale.saleDate, stateRulesConfig)) {
    daysByLocation[state] = totalWorkingDays;
  }

  const discountPerShare = purchase.fmvPerShareAtPurchase - purchase.purchasePricePerShare;
  const ordinaryIncome = computeEsppOrdinaryIncome(purchase, sale);

  const fractionByLocation: Record<string, number> = {};
  const ordinaryIncomeByLocation: Record<string, number> = {};

  for (const [loc, days] of Object.entries(daysByLocation)) {
    const frac = totalWorkingDays > 0 ? days / totalWorkingDays : 0;
    fractionByLocation[loc] = frac;
    ordinaryIncomeByLocation[loc] = ordinaryIncome * frac;
  }

  return {
    purchaseId: purchase.id,
    saleDate: sale.saleDate,
    shares: sale.shares,
    dispositionType: sale.dispositionType,
    ordinaryIncome,
    discountPerShare,
    daysByLocation,
    totalDays: totalWorkingDays,
    fractionByLocation,
    ordinaryIncomeByLocation,
  };
}

interface YearBucket {
  vestAllocations: VestAllocation[];
  esppSaleAllocations: EsppSaleAllocation[];
}

export function computeAllocations(input: InputData): TaxYearSummary[] {
  const byYear = new Map<number, YearBucket>();

  function bucket(year: number): YearBucket {
    if (!byYear.has(year)) byYear.set(year, { vestAllocations: [], esppSaleAllocations: [] });
    return byYear.get(year)!;
  }

  const stateRulesConfig = buildStateRulesConfigFromInput(input);

  // ── RSU vests ──
  for (const grant of input.grants) {
    for (const vest of grant.vests) {
      const alloc = allocateVest(
        grant,
        vest,
        input.workIntervals,
        input.nonWorkingIntervals,
        stateRulesConfig,
      );
      bucket(vest.date.year).vestAllocations.push(alloc);
    }
  }

  // ── ESPP sales ──
  const purchasesById = new Map<string, EsppPurchase>();
  for (const p of input.esppPurchases ?? []) {
    purchasesById.set(p.id, p);
  }

  for (const sale of input.esppSales ?? []) {
    const purchase = purchasesById.get(sale.purchaseId);
    if (!purchase) {
      throw new Error(
        `ESPP sale references unknown purchase "${sale.purchaseId}" — not found in esppPurchases`,
      );
    }
    const alloc = allocateEsppSale(
      purchase,
      sale,
      input.workIntervals,
      input.nonWorkingIntervals,
      stateRulesConfig,
    );
    bucket(sale.saleDate.year).esppSaleAllocations.push(alloc);
  }

  // ── Build summaries ──
  const summaries: TaxYearSummary[] = [];

  for (const [taxYear, { vestAllocations, esppSaleAllocations }] of [...byYear.entries()].toSorted(
    (a, b) => a[0] - b[0],
  )) {
    const totalVestIncome = vestAllocations.reduce((s, v) => s + v.income, 0);
    const totalEsppIncome = esppSaleAllocations.reduce((s, e) => s + e.ordinaryIncome, 0);
    const totalIncome = totalVestIncome + totalEsppIncome;

    const totalShares =
      vestAllocations.reduce((s, v) => s + v.shares, 0) +
      esppSaleAllocations.reduce((s, e) => s + e.shares, 0);

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

    for (const ea of esppSaleAllocations) {
      for (const [loc, frac] of Object.entries(ea.fractionByLocation)) {
        const weight = totalIncome > 0 ? ea.ordinaryIncome / totalIncome : 0;
        weightedFractionByLocation[loc] = (weightedFractionByLocation[loc] ?? 0) + frac * weight;
      }
      for (const [loc, locIncome] of Object.entries(ea.ordinaryIncomeByLocation)) {
        totalIncomeByLocation[loc] = (totalIncomeByLocation[loc] ?? 0) + locIncome;
      }
    }

    summaries.push({
      taxYear,
      vestAllocations,
      esppSaleAllocations,
      weightedFractionByLocation,
      totalShares,
      totalIncome,
      totalIncomeByLocation,
    });
  }

  return summaries;
}

/**
 * Compute calendar-year working-day allocations for salary sourcing.
 *
 * Per 20 NYCRR §132.18(a), salary (i.e. non-equity W-2 compensation) is
 * allocated to NY using a simple working-day fraction over the calendar year:
 *
 *   NY salary = total salary × (NY working days / total working days)
 *
 * This is distinct from RSU/ESPP allocation, which uses grant→vest or
 * offering→purchase windows.
 *
 * Fractions may sum to >1.0 because multiple states can independently
 * claim the same day's income.
 *
 * Computes one SalaryAllocation per calendar year that has any work-interval
 * coverage.
 */
export function computeSalaryAllocations(input: InputData): SalaryAllocation[] {
  const stateRulesConfig = buildStateRulesConfigFromInput(input);

  if (input.workIntervals.length === 0) return [];

  let minYear = Infinity;
  let maxYear = -Infinity;
  for (const wi of input.workIntervals) {
    minYear = Math.min(minYear, wi.start.year);
    maxYear = Math.max(maxYear, wi.end.year);
  }

  const allocations: SalaryAllocation[] = [];

  for (let year = minYear; year <= maxYear; year++) {
    const janFirst = Temporal.PlainDate.from({ year, month: 1, day: 1 });
    const decLast = Temporal.PlainDate.from({ year, month: 12, day: 31 });

    const { daysByLocation, totalWorkingDays } = countWorkingDaysByLocation(
      janFirst,
      decLast,
      input.workIntervals,
      input.nonWorkingIntervals,
      stateRulesConfig,
    );

    const fractionByLocation: Record<string, number> = {};
    for (const [loc, days] of Object.entries(daysByLocation)) {
      fractionByLocation[loc] = totalWorkingDays > 0 ? days / totalWorkingDays : 0;
    }

    allocations.push({
      year,
      daysByLocation,
      totalDays: totalWorkingDays,
      fractionByLocation,
    });
  }

  return allocations;
}

function buildStateRulesConfigFromInput(input: InputData): StateRulesConfig {
  return buildStateRulesConfig(
    input.workIntervals,
    input.nonWorkingIntervals,
    input.domicileIntervals,
    input.statutoryResidences,
    input.reportingEvents,
  );
}
