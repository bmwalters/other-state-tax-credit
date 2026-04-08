import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { schwab } from "../../../src/input/brokerage/schwab.ts";
import type { FileMap } from "../../../src/types.ts";

function makeFiles(entries: Record<string, unknown>): FileMap {
  return new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
}

const awardsJson = {
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
      },
    ],
  },
};

const transactionsJson = {
  Transactions: [
    {
      Date: "03/01/2024",
      Action: "Lapse",
      Symbol: "XYZ",
      Quantity: "250",
      TransactionDetails: [
        { Details: { AwardDate: "06/15/2023", AwardId: "A100", FairMarketValuePrice: "$38.01" } },
      ],
    },
    {
      Date: "06/01/2024",
      Action: "Lapse",
      Symbol: "XYZ",
      Quantity: "250",
      TransactionDetails: [
        { Details: { AwardDate: "06/15/2023", AwardId: "A100", FairMarketValuePrice: "$29.27" } },
      ],
    },
    {
      Date: "06/01/2024",
      Action: "Deposit",
      Symbol: "XYZ",
      Quantity: "486",
      Description: "ESPP",
      TransactionDetails: [{ Details: { PurchaseDate: "05/31/2024" } }],
    },
  ],
};

describe("canImport", () => {
  it("accepts when both Awards and Transactions files are present", () => {
    const files = makeFiles({ "Awards.json": awardsJson, "Transactions.json": transactionsJson });
    expect(schwab.canImport(files)).toBe(true);
  });

  it("rejects when Awards file is missing", () => {
    const files = makeFiles({ "Transactions.json": transactionsJson });
    expect(schwab.canImport(files)).toBe(false);
  });

  it("rejects when Transactions file is missing", () => {
    const files = makeFiles({ "Awards.json": awardsJson });
    expect(schwab.canImport(files)).toBe(false);
  });
});

describe("import", () => {
  it("builds grants from lapse transactions with FMV", () => {
    const files = makeFiles({ "Awards.json": awardsJson, "Transactions.json": transactionsJson });
    const grants = schwab.import(files);

    expect(grants).toHaveLength(1);
    const g = grants[0];
    expect(g.id).toBe("A100");
    expect(g.symbol).toBe("XYZ");
    expect(g.awardDate.equals(Temporal.PlainDate.from("2023-06-15"))).toBe(true);
    expect(g.vests).toHaveLength(2);

    expect(g.vests[0].shares).toBe(250);
    expect(g.vests[0].date.equals(Temporal.PlainDate.from("2024-03-01"))).toBe(true);
    expect(g.vests[0].fmvPerShare).toBe(38.01);

    expect(g.vests[1].shares).toBe(250);
    expect(g.vests[1].date.equals(Temporal.PlainDate.from("2024-06-01"))).toBe(true);
    expect(g.vests[1].fmvPerShare).toBe(29.27);
  });

  it("ignores non-Lapse transactions", () => {
    const files = makeFiles({ "Awards.json": awardsJson, "Transactions.json": transactionsJson });
    const grants = schwab.import(files);
    const allVests = grants.flatMap((g) => g.vests);
    expect(allVests).toHaveLength(2);
  });

  it("throws when a lapse references an unknown award", () => {
    const badTx = {
      Transactions: [
        {
          Date: "03/01/2024",
          Action: "Lapse",
          Symbol: "XYZ",
          Quantity: "100",
          TransactionDetails: [
            {
              Details: {
                AwardDate: "01/01/2023",
                AwardId: "UNKNOWN",
                FairMarketValuePrice: "$10.00",
              },
            },
          ],
        },
      ],
    };
    const files = makeFiles({ "Awards.json": awardsJson, "Transactions.json": badTx });
    expect(() => schwab.import(files)).toThrow("unknown award UNKNOWN");
  });

  it("merges lapse events from multiple transaction files", () => {
    const tx1 = {
      Transactions: [transactionsJson.Transactions[0]],
    };
    const tx2 = {
      Transactions: [transactionsJson.Transactions[1]],
    };
    const files = makeFiles({ "Awards.json": awardsJson, "tx1.json": tx1, "tx2.json": tx2 });
    const grants = schwab.import(files);

    expect(grants).toHaveLength(1);
    expect(grants[0].vests).toHaveLength(2);
  });
});
