import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { computeAllocations } from "../src/engine.ts";
import type { InputData } from "../src/types.ts";

function pd(s: string) {
  return Temporal.PlainDate.from(s);
}

describe("computeAllocations – RSU", () => {
  it("allocates 100% to a single location when all work is there", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 100, fmvPerShare: 50 }],
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].taxYear).toBe(2024);
    expect(result[0].totalShares).toBe(100);
    expect(result[0].totalIncome).toBe(5000);
    expect(result[0].vestAllocations[0].fractionByLocation["US-NY"]).toBeCloseTo(1.0);
    expect(result[0].vestAllocations[0].incomeByLocation["US-NY"]).toBeCloseTo(5000);
    expect(result[0].totalIncomeByLocation["US-NY"]).toBeCloseTo(5000);
    expect(result[0].esppSaleAllocations).toHaveLength(0);
  });

  it("splits proportionally across two locations", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 200, fmvPerShare: 30 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-04-01"), location: "US-NY" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    expect(alloc.daysByLocation["US-NY"]).toBe(91);
    expect(alloc.daysByLocation["US-CA"]).toBe(91);
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(0.5);
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(0.5);
    expect(alloc.income).toBe(6000);
    expect(alloc.incomeByLocation["US-NY"]).toBeCloseTo(3000);
    expect(alloc.incomeByLocation["US-CA"]).toBeCloseTo(3000);
  });

  it("only counts days within the grant-to-vest window", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-03-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-06-01"), shares: 50, fmvPerShare: 20 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-04-01"), location: "US-NY" },
        { start: pd("2024-04-01"), end: pd("2024-09-01"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    expect(alloc.daysByLocation["US-NY"]).toBe(31);
    expect(alloc.daysByLocation["US-CA"]).toBe(61);
    expect(alloc.totalDays).toBe(92);
  });

  it("groups vests by tax year", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2023-01-01"),
          symbol: "XYZ",
          vests: [
            { date: pd("2023-07-01"), shares: 100, fmvPerShare: 10 },
            { date: pd("2024-01-01"), shares: 100, fmvPerShare: 15 },
          ],
        },
      ],
      workIntervals: [{ start: pd("2023-01-01"), end: pd("2025-01-01"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(2);
    expect(result[0].taxYear).toBe(2023);
    expect(result[1].taxYear).toBe(2024);
  });

  it("uses total calendar days as denominator, not just declared days", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 100, fmvPerShare: 40 }],
        },
      ],
      workIntervals: [{ start: pd("2024-03-01"), end: pd("2024-03-11"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    expect(alloc.totalDays).toBe(182);
    expect(alloc.daysByLocation["US-NY"]).toBe(10);
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(10 / 182);
    expect(alloc.incomeByLocation["US-NY"]).toBeCloseTo(4000 * (10 / 182));
  });

  it("weights fractions by income, not share count", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 100, fmvPerShare: 10 }],
        },
        {
          id: "G2",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 100, fmvPerShare: 90 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-04-01"), location: "US-NY" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    // Both grants have identical date ranges, so weighted average = simple average
    expect(result[0].weightedFractionByLocation["US-NY"]).toBeCloseTo(0.5);
    expect(result[0].totalIncome).toBe(10000);
    expect(result[0].totalIncomeByLocation["US-NY"]).toBeCloseTo(5000);
  });
});

describe("computeAllocations – ESPP", () => {
  it("allocates 100% of ESPP ordinary income to single location", () => {
    // 6-month offering, all work in NY, sell immediately
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-01-01"),
          purchaseDate: pd("2024-07-01"),
          purchasePricePerShare: 42.5, // 15% discount from $50
          fmvPerShareAtPurchase: 50,
          shares: 100,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2024-09-15"),
          salePricePerShare: 55,
          shares: 100,
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].taxYear).toBe(2024);
    expect(result[0].esppSaleAllocations).toHaveLength(1);

    const alloc = result[0].esppSaleAllocations[0];
    expect(alloc.purchaseId).toBe("ESPP1");
    expect(alloc.discountPerShare).toBeCloseTo(7.5); // 50 - 42.5
    expect(alloc.ordinaryIncome).toBeCloseTo(750); // 7.5 * 100
    expect(alloc.totalDays).toBe(182); // Jan 1 to Jul 1
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(1.0);
    expect(alloc.ordinaryIncomeByLocation["US-NY"]).toBeCloseTo(750);
  });

  it("allocates ESPP discount based on offering period, not sale date", () => {
    // 6-month offering, worked in NY for 2 months then moved to CA
    // Per spec: "If you worked in NY for 2 months of a 6-month ESPP period,
    // NY will generally want 1/3 of that discount amount."
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-01-01"),
          purchaseDate: pd("2024-07-01"),
          purchasePricePerShare: 42.5,
          fmvPerShareAtPurchase: 50,
          shares: 100,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2024-10-01"),
          salePricePerShare: 55,
          shares: 100,
        },
      ],
      workIntervals: [
        // 2 months in NY (Jan 1 – Mar 1)
        { start: pd("2024-01-01"), end: pd("2024-03-01"), location: "US-NY" },
        // 4 months in CA (Mar 1 – Jul 1)
        { start: pd("2024-03-01"), end: pd("2024-07-01"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].esppSaleAllocations[0];

    // 60 days in NY, 122 days in CA, total 182 days
    expect(alloc.daysByLocation["US-NY"]).toBe(60);
    expect(alloc.daysByLocation["US-CA"]).toBe(122);
    expect(alloc.totalDays).toBe(182);

    const nyFrac = 60 / 182;
    const caFrac = 122 / 182;
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(nyFrac);
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(caFrac);
    expect(alloc.ordinaryIncomeByLocation["US-NY"]).toBeCloseTo(750 * nyFrac);
    expect(alloc.ordinaryIncomeByLocation["US-CA"]).toBeCloseTo(750 * caFrac);
  });

  it("groups ESPP sales by the sale year (not purchase year)", () => {
    // Purchase in 2024, sell in 2025
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-01-01"),
          purchaseDate: pd("2024-07-01"),
          purchasePricePerShare: 42.5,
          fmvPerShareAtPurchase: 50,
          shares: 200,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2025-03-01"),
          salePricePerShare: 60,
          shares: 200,
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2025-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].taxYear).toBe(2025); // sale year, not purchase year
    expect(result[0].esppSaleAllocations).toHaveLength(1);
    expect(result[0].esppSaleAllocations[0].ordinaryIncome).toBeCloseTo(1500); // 7.5 * 200
  });

  it("handles partial sales from same purchase lot", () => {
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-01-01"),
          purchaseDate: pd("2024-07-01"),
          purchasePricePerShare: 42.5,
          fmvPerShareAtPurchase: 50,
          shares: 200,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2024-09-01"),
          salePricePerShare: 55,
          shares: 50,
        },
        {
          purchaseId: "ESPP1",
          saleDate: pd("2025-02-01"),
          salePricePerShare: 60,
          shares: 150,
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2025-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(2);

    // 2024: 50 shares sold → ordinary income = 7.5 * 50 = 375
    expect(result[0].taxYear).toBe(2024);
    expect(result[0].esppSaleAllocations[0].ordinaryIncome).toBeCloseTo(375);

    // 2025: 150 shares sold → ordinary income = 7.5 * 150 = 1125
    expect(result[1].taxYear).toBe(2025);
    expect(result[1].esppSaleAllocations[0].ordinaryIncome).toBeCloseTo(1125);
  });

  it("throws on sale referencing unknown purchase", () => {
    const input: InputData = {
      grants: [],
      esppPurchases: [],
      esppSales: [
        {
          purchaseId: "BOGUS",
          saleDate: pd("2024-09-01"),
          salePricePerShare: 55,
          shares: 50,
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
    };

    expect(() => computeAllocations(input)).toThrow(/unknown purchase "BOGUS"/);
  });

  it("combines RSU and ESPP income in the same tax year", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 100, fmvPerShare: 50 }],
        },
      ],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-01-01"),
          purchaseDate: pd("2024-07-01"),
          purchasePricePerShare: 42.5,
          fmvPerShareAtPurchase: 50,
          shares: 100,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2024-09-01"),
          salePricePerShare: 55,
          shares: 100,
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(1);

    const summary = result[0];
    const rsuIncome = 100 * 50; // 5000
    const esppOrdinaryIncome = 7.5 * 100; // 750
    expect(summary.totalIncome).toBeCloseTo(rsuIncome + esppOrdinaryIncome);
    expect(summary.totalShares).toBe(200); // 100 RSU + 100 ESPP
    expect(summary.vestAllocations).toHaveLength(1);
    expect(summary.esppSaleAllocations).toHaveLength(1);
    expect(summary.totalIncomeByLocation["US-NY"]).toBeCloseTo(rsuIncome + esppOrdinaryIncome);
    expect(summary.weightedFractionByLocation["US-NY"]).toBeCloseTo(1.0);
  });

  it("uses offering period for allocation even when sale is much later", () => {
    // Offering period: Jan 2023 – Jul 2023 (all in NY)
    // Sale: Dec 2025 (now working in CA — but that doesn't matter)
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2023-01-01"),
          purchaseDate: pd("2023-07-01"),
          purchasePricePerShare: 40,
          fmvPerShareAtPurchase: 50,
          shares: 100,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2025-12-15"),
          salePricePerShare: 80,
          shares: 100,
        },
      ],
      workIntervals: [
        { start: pd("2023-01-01"), end: pd("2024-01-01"), location: "US-NY" },
        { start: pd("2024-01-01"), end: pd("2026-01-01"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].taxYear).toBe(2025); // sale year

    const alloc = result[0].esppSaleAllocations[0];
    // Offering period Jan 1 – Jul 1, 2023 = entirely in NY
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(1.0);
    expect(alloc.fractionByLocation["US-CA"]).toBeUndefined();
    expect(alloc.ordinaryIncome).toBeCloseTo(1000); // (50-40) * 100
    expect(alloc.ordinaryIncomeByLocation["US-NY"]).toBeCloseTo(1000);
  });

  it("handles ESPP with no grants (ESPP-only input)", () => {
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-06-01"),
          purchaseDate: pd("2024-12-01"),
          purchasePricePerShare: 38,
          fmvPerShareAtPurchase: 45,
          shares: 50,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2024-12-15"),
          salePricePerShare: 48,
          shares: 50,
        },
      ],
      workIntervals: [
        { start: pd("2024-06-01"), end: pd("2024-09-01"), location: "US-NY" },
        { start: pd("2024-09-01"), end: pd("2024-12-01"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].vestAllocations).toHaveLength(0);
    expect(result[0].esppSaleAllocations).toHaveLength(1);

    const alloc = result[0].esppSaleAllocations[0];
    const totalDays = 183; // Jun 1 to Dec 1
    const nyDays = 92; // Jun 1 to Sep 1
    const caDays = 91; // Sep 1 to Dec 1
    expect(alloc.totalDays).toBe(totalDays);
    expect(alloc.daysByLocation["US-NY"]).toBe(nyDays);
    expect(alloc.daysByLocation["US-CA"]).toBe(caDays);
    expect(alloc.discountPerShare).toBeCloseTo(7); // 45 - 38
    expect(alloc.ordinaryIncome).toBeCloseTo(350); // 7 * 50
  });
});
