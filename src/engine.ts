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
import {
  buildDayLocationMap,
  buildNonWorkingSet,
  countWorkingDaysByLocation,
  isWeekday,
} from "./workdays.ts";
import {
  buildStateRulesConfig,
  getResidentStates,
  resolveClaimingStates,
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
  const residentStates = new Set(getResidentStates(vest.date, stateRulesConfig));
  for (const state of residentStates) {
    daysByLocation[state] = totalWorkingDays;
  }

  const fractionByLocation: Record<string, number> = {};
  const residentIncomeByState: Record<string, number> = {};
  const nonresidentIncomeByState: Record<string, number> = {};
  const income = vest.shares * vest.fmvPerShare;

  for (const [loc, days] of Object.entries(daysByLocation)) {
    const frac = totalWorkingDays > 0 ? days / totalWorkingDays : 0;
    fractionByLocation[loc] = frac;
    const locIncome = income * frac;

    if (residentStates.has(loc)) {
      residentIncomeByState[loc] = locIncome;
    } else {
      nonresidentIncomeByState[loc] = locIncome;
    }
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
    residentIncomeByState,
    nonresidentIncomeByState,
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
  const residentStates = new Set(getResidentStates(sale.saleDate, stateRulesConfig));
  for (const state of residentStates) {
    daysByLocation[state] = totalWorkingDays;
  }

  const discountPerShare = purchase.fmvPerShareAtPurchase - purchase.purchasePricePerShare;
  const ordinaryIncome = computeEsppOrdinaryIncome(purchase, sale);

  const fractionByLocation: Record<string, number> = {};
  const residentOrdinaryIncomeByState: Record<string, number> = {};
  const nonresidentOrdinaryIncomeByState: Record<string, number> = {};

  for (const [loc, days] of Object.entries(daysByLocation)) {
    const frac = totalWorkingDays > 0 ? days / totalWorkingDays : 0;
    fractionByLocation[loc] = frac;
    const locIncome = ordinaryIncome * frac;

    if (residentStates.has(loc)) {
      residentOrdinaryIncomeByState[loc] = locIncome;
    } else {
      nonresidentOrdinaryIncomeByState[loc] = locIncome;
    }
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
    residentOrdinaryIncomeByState,
    nonresidentOrdinaryIncomeByState,
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

    const totalResidentIncomeByState: Record<string, number> = {};
    const totalNonresidentIncomeByState: Record<string, number> = {};

    for (const va of vestAllocations) {
      for (const [loc, inc] of Object.entries(va.residentIncomeByState)) {
        totalResidentIncomeByState[loc] = (totalResidentIncomeByState[loc] ?? 0) + inc;
      }
      for (const [loc, inc] of Object.entries(va.nonresidentIncomeByState)) {
        totalNonresidentIncomeByState[loc] = (totalNonresidentIncomeByState[loc] ?? 0) + inc;
      }
    }

    for (const ea of esppSaleAllocations) {
      for (const [loc, inc] of Object.entries(ea.residentOrdinaryIncomeByState)) {
        totalResidentIncomeByState[loc] = (totalResidentIncomeByState[loc] ?? 0) + inc;
      }
      for (const [loc, inc] of Object.entries(ea.nonresidentOrdinaryIncomeByState)) {
        totalNonresidentIncomeByState[loc] = (totalNonresidentIncomeByState[loc] ?? 0) + inc;
      }
    }

    summaries.push({
      taxYear,
      vestAllocations,
      esppSaleAllocations,
      totalShares,
      totalIncome,
      totalResidentIncomeByState,
      totalNonresidentIncomeByState,
    });
  }

  return summaries;
}

/**
 * Compute calendar-year working-day allocations for salary sourcing.
 *
 * Per 20 NYCRR §132.18(a), salary (i.e. non-equity W-2 compensation) is
 * allocated to a state using a simple working-day fraction over the calendar
 * year:
 *
 *   state salary = total salary × (state working days / total working days)
 *
 * Days are split into resident (domicile / statutory residence on that
 * date) vs. nonresident (physical work location only). The cross-state
 * source days track "days I physically worked in state B while being a
 * resident of state A" — needed for other-state tax credit (OSTC)
 * calculations.
 *
 * Computes one SalaryAllocation per calendar year that has any
 * work-interval coverage.
 */
export function computeSalaryAllocations(input: InputData): SalaryAllocation[] {
  const config = buildStateRulesConfigFromInput(input);

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

    const nonWorkingDays = buildNonWorkingSet(input.nonWorkingIntervals, janFirst, decLast);
    const dayLocation = buildDayLocationMap(janFirst, decLast, input.workIntervals, nonWorkingDays);

    const residentDaysByState: Record<string, number> = {};
    const nonresidentDaysByState: Record<string, number> = {};
    const crossStateSourceDays: Record<string, Record<string, number>> = {};
    let totalDays = 0;

    let cursor = janFirst;
    while (Temporal.PlainDate.compare(cursor, decLast) <= 0) {
      const key = cursor.toString();
      if (isWeekday(cursor) && !nonWorkingDays.has(key)) {
        totalDays++;
        const physicalLocation = dayLocation.get(key);
        const claimingStates = resolveClaimingStates(cursor, physicalLocation, config);
        const residentStates = new Set(getResidentStates(cursor, config));

        for (const state of claimingStates) {
          if (residentStates.has(state)) {
            residentDaysByState[state] = (residentDaysByState[state] ?? 0) + 1;
          } else {
            nonresidentDaysByState[state] = (nonresidentDaysByState[state] ?? 0) + 1;
            // Record cross-state: this nonresident day in `state` while
            // being a resident of each `resState`.
            for (const resState of residentStates) {
              const bucket = (crossStateSourceDays[resState] ??= {});
              bucket[state] = (bucket[state] ?? 0) + 1;
            }
          }
        }
      }
      cursor = cursor.add({ days: 1 });
    }

    allocations.push({
      year,
      totalDays,
      residentDaysByState,
      nonresidentDaysByState,
      crossStateSourceDays,
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
