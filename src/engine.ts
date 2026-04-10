import { Temporal } from "temporal-polyfill";
import type {
  EsppPurchase,
  EsppSale,
  EsppSaleAllocation,
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

/**
 * Allocate the ordinary income from an ESPP sale across work locations.
 *
 * The allocation period is the offering period (offering start → purchase date),
 * NOT the period up to the sale date. The taxable event occurs on the sale date
 * and falls into that sale's tax year.
 */
function allocateEsppSale(
  purchase: EsppPurchase,
  sale: EsppSale,
  workIntervals: WorkInterval[],
): EsppSaleAllocation {
  const daysByLocation = countDaysByLocation(
    purchase.offeringStartDate,
    purchase.purchaseDate,
    workIntervals,
  );
  const totalDays = purchase.offeringStartDate.until(purchase.purchaseDate).total("day");

  const discountPerShare = purchase.fmvPerShareAtPurchase - purchase.purchasePricePerShare;
  const ordinaryIncome = discountPerShare * sale.shares;

  const fractionByLocation: Record<string, number> = {};
  const ordinaryIncomeByLocation: Record<string, number> = {};

  for (const [loc, days] of Object.entries(daysByLocation)) {
    const frac = totalDays > 0 ? days / totalDays : 0;
    fractionByLocation[loc] = frac;
    ordinaryIncomeByLocation[loc] = ordinaryIncome * frac;
  }

  return {
    purchaseId: purchase.id,
    saleDate: sale.saleDate,
    shares: sale.shares,
    ordinaryIncome,
    discountPerShare,
    daysByLocation,
    totalDays,
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

  // ── RSU vests ──
  for (const grant of input.grants) {
    for (const vest of grant.vests) {
      const alloc = allocateVest(grant, vest, input.workIntervals);
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
    const alloc = allocateEsppSale(purchase, sale, input.workIntervals);
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
