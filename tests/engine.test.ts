import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { computeAllocations } from "../src/engine.ts";
import type { InputData } from "../src/types.ts";

function pd(s: string) {
  return Temporal.PlainDate.from(s);
}

describe("computeAllocations", () => {
  it("allocates 100% to a single location when all work is there", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 100 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" },
      ],
    };

    const result = computeAllocations(input);
    expect(result).toHaveLength(1);
    expect(result[0].taxYear).toBe(2024);
    expect(result[0].totalShares).toBe(100);
    expect(result[0].vestAllocations[0].fractionByLocation["US-NY"]).toBeCloseTo(1.0);
  });

  it("splits proportionally across two locations", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 200 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-04-01"), location: "US-NY" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    // 91 days NY (Jan 1 – Apr 1), 91 days CA (Apr 1 – Jul 1)
    expect(alloc.daysByLocation["US-NY"]).toBe(91);
    expect(alloc.daysByLocation["US-CA"]).toBe(91);
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(0.5);
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(0.5);
  });

  it("only counts days within the grant-to-vest window", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-03-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-06-01"), shares: 50 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-04-01"), location: "US-NY" },
        { start: pd("2024-04-01"), end: pd("2024-09-01"), location: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    // Grant 2024-03-01 to vest 2024-06-01
    // NY: Mar 1 – Apr 1 = 31 days
    // CA: Apr 1 – Jun 1 = 61 days
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
            { date: pd("2023-07-01"), shares: 100 },
            { date: pd("2024-01-01"), shares: 100 },
          ],
        },
      ],
      workIntervals: [
        { start: pd("2023-01-01"), end: pd("2025-01-01"), location: "US-NY" },
      ],
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
          vests: [{ date: pd("2024-07-01"), shares: 100 }],
        },
      ],
      workIntervals: [
        // Only 10 days of NY declared out of 182 calendar days
        { start: pd("2024-03-01"), end: pd("2024-03-11"), location: "US-NY" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    expect(alloc.totalDays).toBe(182);
    expect(alloc.daysByLocation["US-NY"]).toBe(10);
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(10 / 182);
  });

  it("computes weighted average across multiple grants in same year", () => {
    const input: InputData = {
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 100 }],
        },
        {
          id: "G2",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 300 }],
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
    expect(result[0].totalShares).toBe(400);
  });
});
