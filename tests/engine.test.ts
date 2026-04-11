import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { computeAllocations, computeSalaryAllocations } from "../src/engine.ts";
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
        { start: pd("2024-01-01"), end: pd("2024-03-31"), location: "US-NY" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    expect(alloc.daysByLocation["US-NY"]).toBe(65);
    expect(alloc.daysByLocation["US-CA"]).toBe(66);
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(65 / 131);
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(66 / 131);
    expect(alloc.income).toBe(6000);
    expect(alloc.incomeByLocation["US-NY"]).toBeCloseTo(6000 * (65 / 131));
    expect(alloc.incomeByLocation["US-CA"]).toBeCloseTo(6000 * (66 / 131));
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
        { start: pd("2024-01-01"), end: pd("2024-03-31"), location: "US-NY" },
        { start: pd("2024-04-01"), end: pd("2024-09-01"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    expect(alloc.daysByLocation["US-NY"]).toBe(21);
    expect(alloc.daysByLocation["US-CA"]).toBe(45);
    expect(alloc.totalDays).toBe(66);
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

  it("excludes listed non-working days from the denominator", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 100, fmvPerShare: 40 }],
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
      nonWorkingIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-01-01"), category: "holiday" },
        { start: pd("2024-05-27"), end: pd("2024-05-27"), category: "holiday" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    expect(alloc.totalDays).toBe(129);
    expect(alloc.daysByLocation["US-NY"]).toBe(129);
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(1);
    expect(alloc.incomeByLocation["US-NY"]).toBeCloseTo(4000);
  });

  it("treats uncovered weekdays as non-NY", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-01-10"), shares: 100, fmvPerShare: 40 }],
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-01-03"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    expect(alloc.totalDays).toBe(8);
    expect(alloc.daysByLocation["US-NY"]).toBe(3);
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(3 / 8);
  });

  it("throws on overlapping work intervals", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-01-10"), shares: 100, fmvPerShare: 40 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" },
        { start: pd("2024-01-05"), end: pd("2024-01-10"), location: "US-CA" },
      ],
    };

    expect(() => computeAllocations(input)).toThrow(/Overlapping work intervals/);
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
        { start: pd("2024-01-01"), end: pd("2024-03-31"), location: "US-NY" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    // Both grants have identical date ranges, so weighted average = simple average
    expect(result[0].weightedFractionByLocation["US-NY"]).toBeCloseTo(65 / 131);
    expect(result[0].totalIncome).toBe(10000);
    expect(result[0].totalIncomeByLocation["US-NY"]).toBeCloseTo(10000 * (65 / 131));
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
          fmvPerShareAtGrant: 50,
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
          dispositionType: "DISQUALIFIED",
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
    expect(alloc.dispositionType).toBe("DISQUALIFIED");
    expect(alloc.discountPerShare).toBeCloseTo(7.5); // 50 - 42.5
    expect(alloc.ordinaryIncome).toBeCloseTo(750); // 7.5 * 100
    expect(alloc.totalDays).toBe(131); // weekdays from Jan 1 to Jul 1, inclusive
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
          fmvPerShareAtGrant: 50,
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
          dispositionType: "DISQUALIFIED",
        },
      ],
      workIntervals: [
        // Jan-Feb in NY
        { start: pd("2024-01-01"), end: pd("2024-02-29"), location: "US-NY" },
        // Mar-Jul 1 in CA
        { start: pd("2024-03-01"), end: pd("2024-07-01"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].esppSaleAllocations[0];

    // 44 working days in NY, 87 in CA, total 131 working days
    expect(alloc.daysByLocation["US-NY"]).toBe(44);
    expect(alloc.daysByLocation["US-CA"]).toBe(87);
    expect(alloc.totalDays).toBe(131);

    const nyFrac = 44 / 131;
    const caFrac = 87 / 131;
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(nyFrac);
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(caFrac);
    expect(alloc.ordinaryIncomeByLocation["US-NY"]).toBeCloseTo(750 * nyFrac);
    expect(alloc.ordinaryIncomeByLocation["US-CA"]).toBeCloseTo(750 * caFrac);
  });

  it("uses actual gain when a disqualifying sale is below purchase-date FMV", () => {
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-01-01"),
          fmvPerShareAtGrant: 50,
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
          salePricePerShare: 45,
          shares: 100,
          dispositionType: "DISQUALIFIED",
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].esppSaleAllocations[0];
    expect(alloc.discountPerShare).toBeCloseTo(7.5);
    expect(alloc.ordinaryIncome).toBeCloseTo(250); // (45 - 42.5) * 100
    expect(alloc.ordinaryIncomeByLocation["US-NY"]).toBeCloseTo(250);
  });

  it("treats disqualifying ESPP loss sales as zero ordinary income", () => {
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-01-01"),
          fmvPerShareAtGrant: 50,
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
          salePricePerShare: 40,
          shares: 100,
          dispositionType: "DISQUALIFIED",
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].esppSaleAllocations[0];
    expect(alloc.discountPerShare).toBeCloseTo(7.5);
    expect(alloc.ordinaryIncome).toBeCloseTo(0);
    expect(alloc.ordinaryIncomeByLocation["US-NY"]).toBeCloseTo(0);
  });

  it("uses the qualified-disposition grant-date discount cap", () => {
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2022-12-01"),
          fmvPerShareAtGrant: 14.41,
          purchaseDate: pd("2023-05-31"),
          purchasePricePerShare: 12.2485,
          fmvPerShareAtPurchase: 14.86,
          shares: 340,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2025-06-02"),
          salePricePerShare: 52.79,
          shares: 340,
          dispositionType: "QUALIFIED",
        },
      ],
      workIntervals: [{ start: pd("2022-12-01"), end: pd("2025-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].esppSaleAllocations[0];
    expect(alloc.dispositionType).toBe("QUALIFIED");
    expect(alloc.discountPerShare).toBeCloseTo(14.86 - 12.2485);
    expect(alloc.ordinaryIncome).toBeCloseTo(734.91); // min(actual gain, grant-date discount)
    expect(alloc.ordinaryIncomeByLocation["US-NY"]).toBeCloseTo(734.91);
  });

  it("caps qualified-disposition ordinary income at actual gain", () => {
    const input: InputData = {
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2022-12-01"),
          fmvPerShareAtGrant: 20,
          purchaseDate: pd("2023-05-31"),
          purchasePricePerShare: 10,
          fmvPerShareAtPurchase: 25,
          shares: 10,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2025-06-02"),
          salePricePerShare: 13,
          shares: 10,
          dispositionType: "QUALIFIED",
        },
      ],
      workIntervals: [{ start: pd("2022-12-01"), end: pd("2025-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].esppSaleAllocations[0];
    expect(alloc.ordinaryIncome).toBeCloseTo(30); // actual gain = (13 - 10) * 10
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
          fmvPerShareAtGrant: 50,
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
          dispositionType: "DISQUALIFIED",
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
          fmvPerShareAtGrant: 50,
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
          dispositionType: "DISQUALIFIED",
        },
        {
          purchaseId: "ESPP1",
          saleDate: pd("2025-02-01"),
          salePricePerShare: 60,
          shares: 150,
          dispositionType: "DISQUALIFIED",
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
          dispositionType: "DISQUALIFIED",
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
          fmvPerShareAtGrant: 50,
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
          dispositionType: "DISQUALIFIED",
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
          fmvPerShareAtGrant: 50,
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
          dispositionType: "QUALIFIED",
        },
      ],
      workIntervals: [
        { start: pd("2023-01-01"), end: pd("2024-01-01"), location: "US-NY" },
        { start: pd("2024-01-02"), end: pd("2026-01-01"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].taxYear).toBe(2025); // sale year

    const alloc = result[0].esppSaleAllocations[0];
    // Offering period Jan 1 – Jul 1, 2023 = entirely in NY
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(1.0);
    expect(alloc.fractionByLocation["US-CA"]).toBeUndefined();
    expect(alloc.ordinaryIncome).toBeCloseTo(1000); // grant-date discount = (50-40) * 100
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
          fmvPerShareAtGrant: 45,
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
          dispositionType: "DISQUALIFIED",
        },
      ],
      workIntervals: [
        { start: pd("2024-06-01"), end: pd("2024-08-31"), location: "US-NY" },
        { start: pd("2024-09-01"), end: pd("2024-12-01"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].vestAllocations).toHaveLength(0);
    expect(result[0].esppSaleAllocations).toHaveLength(1);

    const alloc = result[0].esppSaleAllocations[0];
    const totalDays = 130; // working days from Jun 1 to Dec 1, inclusive
    const nyDays = 65; // Jun 1 to Aug 31 working days
    const caDays = 65; // Sep 1 to Dec 1 working days
    expect(alloc.totalDays).toBe(totalDays);
    expect(alloc.daysByLocation["US-NY"]).toBe(nyDays);
    expect(alloc.daysByLocation["US-CA"]).toBe(caDays);
    expect(alloc.discountPerShare).toBeCloseTo(7); // 45 - 38
    expect(alloc.ordinaryIncome).toBeCloseTo(350); // 7 * 50
  });
});

describe("computeSalaryAllocations", () => {
  it("computes 100% for a single location covering the full year", () => {
    const input: InputData = {
      grants: [],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
    };

    const result = computeSalaryAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].year).toBe(2024);
    expect(result[0].totalDays).toBe(262); // 2024 has 262 weekdays
    expect(result[0].daysByLocation["US-NY"]).toBe(262);
    expect(result[0].fractionByLocation["US-NY"]).toBeCloseTo(1.0);
  });

  it("splits across two locations in the same year", () => {
    const input: InputData = {
      grants: [],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-06-30"), location: "US-NY" },
        { start: pd("2024-07-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
    };

    const result = computeSalaryAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].year).toBe(2024);
    const nyDays = result[0].daysByLocation["US-NY"]!;
    const caDays = result[0].daysByLocation["US-CA"]!;
    expect(nyDays + caDays).toBe(262);
    expect(result[0].fractionByLocation["US-NY"]).toBeCloseTo(nyDays / 262);
    expect(result[0].fractionByLocation["US-CA"]).toBeCloseTo(caDays / 262);
  });

  it("spans multiple calendar years", () => {
    const input: InputData = {
      grants: [],
      workIntervals: [
        { start: pd("2023-01-01"), end: pd("2024-12-31"), location: "US-NY" },
      ],
    };

    const result = computeSalaryAllocations(input);
    expect(result).toHaveLength(2);
    expect(result[0].year).toBe(2023);
    expect(result[1].year).toBe(2024);
    expect(result[0].fractionByLocation["US-NY"]).toBeCloseTo(1.0);
    expect(result[1].fractionByLocation["US-NY"]).toBeCloseTo(1.0);
  });

  it("excludes holidays from both numerator and denominator", () => {
    const input: InputData = {
      grants: [],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
      nonWorkingIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-01-01"), category: "holiday" },
        { start: pd("2024-12-25"), end: pd("2024-12-25"), category: "holiday" },
      ],
    };

    const result = computeSalaryAllocations(input);
    expect(result[0].totalDays).toBe(260); // 262 - 2 holidays
    expect(result[0].daysByLocation["US-NY"]).toBe(260);
    expect(result[0].fractionByLocation["US-NY"]).toBeCloseTo(1.0);
  });

  it("treats uncovered weekdays as non-NY (reduces NY fraction)", () => {
    // Only cover Jan in NY; rest of year uncovered
    const input: InputData = {
      grants: [],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-01-31"), location: "US-NY" }],
    };

    const result = computeSalaryAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].totalDays).toBe(262); // full year denominator
    expect(result[0].daysByLocation["US-NY"]).toBe(23); // weekdays in Jan 2024
    expect(result[0].fractionByLocation["US-NY"]).toBeCloseTo(23 / 262);
  });

  it("returns empty for no work intervals", () => {
    const input: InputData = {
      grants: [],
      workIntervals: [],
    };

    const result = computeSalaryAllocations(input);
    expect(result).toHaveLength(0);
  });
});
