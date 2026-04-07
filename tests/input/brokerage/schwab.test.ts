import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { schwab } from "../../../src/input/brokerage/schwab.ts";

const minimalAward = {
  awardsDetail: {
    restrictedStockUnits: [
      {
        awardId: 1001,
        awardName: "A100",
        awardDate: "2023-06-15T00:00:00",
        awardType: "RSU",
        symbol: "XYZ",
        pastVestings: [
          { vestDate: "2024-03-01T00:00:00", vestAmount: 250 },
          { vestDate: "2024-06-01T00:00:00", vestAmount: 250 },
        ],
        vestingSchedules: [{ vestDate: "2024-09-01T00:00:00", vestAmount: 250 }],
      },
    ],
  },
};

describe("canImport", () => {
  it("accepts a JSON file with awardsDetail.restrictedStockUnits", () => {
    expect(schwab.canImport("Awards.json", JSON.stringify(minimalAward))).toBe(true);
  });

  it("rejects non-JSON filenames", () => {
    expect(schwab.canImport("data.csv", JSON.stringify(minimalAward))).toBe(false);
  });
});

describe("import", () => {
  it("parses grants with past and future vestings", () => {
    const grants = schwab.import("Awards.json", JSON.stringify(minimalAward));

    expect(grants).toHaveLength(1);
    const g = grants[0];
    expect(g.id).toBe("A100");
    expect(g.symbol).toBe("XYZ");
    expect(g.awardDate.equals(Temporal.PlainDate.from("2023-06-15"))).toBe(true);
    expect(g.vests).toHaveLength(3);
    expect(g.vests[0].shares).toBe(250);
    expect(g.vests[0].date.equals(Temporal.PlainDate.from("2024-03-01"))).toBe(true);
  });
});
