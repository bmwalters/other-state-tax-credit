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

describe("import – RSU", () => {
  it("builds grants from lapse transactions with FMV", () => {
    const files = makeFiles({ "Awards.json": awardsJson, "Transactions.json": transactionsJson });
    const { grants } = schwab.import(files);

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

  it("ignores non-Lapse transactions for RSU grants", () => {
    const files = makeFiles({ "Awards.json": awardsJson, "Transactions.json": transactionsJson });
    const { grants } = schwab.import(files);
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
    const { grants } = schwab.import(files);

    expect(grants).toHaveLength(1);
    expect(grants[0].vests).toHaveLength(2);
  });
});

describe("import – ESPP", () => {
  const esppTransactions = {
    Transactions: [
      {
        Date: "12/02/2024",
        Action: "Deposit",
        Symbol: "XYZ",
        Quantity: "389",
        Description: "ESPP",
        TransactionDetails: [
          {
            Details: {
              PurchaseDate: "11/30/2024",
              PurchasePrice: "$24.88",
              SubscriptionDate: "06/01/2024",
              SubscriptionFairMarketValue: "$29.27",
              PurchaseFairMarketValue: "$70.01",
            },
          },
        ],
      },
      {
        Date: "12/03/2024",
        Action: "Sale",
        Symbol: "XYZ",
        Quantity: "389",
        Description: "Share Sale",
        TransactionDetails: [
          {
            Details: {
              Type: "ESPP",
              Shares: "389",
              SalePrice: "$70.40",
              SubscriptionDate: "06/01/2024",
              SubscriptionFairMarketValue: "$29.27",
              PurchaseDate: "11/30/2024",
              PurchasePrice: "$24.88",
              PurchaseFairMarketValue: "$70.01",
              DispositionType: "Disqualified",
            },
          },
        ],
      },
    ],
  };

  it("parses ESPP Deposit into purchase lot", () => {
    const files = makeFiles({
      "Awards.json": awardsJson,
      "Transactions.json": esppTransactions,
    });
    const result = schwab.import(files);
    expect(result.esppPurchases).toHaveLength(1);

    const p = result.esppPurchases![0];
    expect(p.id).toBe("ESPP-06/01/2024-11/30/2024");
    expect(p.symbol).toBe("XYZ");
    expect(p.offeringStartDate.equals(Temporal.PlainDate.from("2024-06-01"))).toBe(true);
    expect(p.fmvPerShareAtGrant).toBe(29.27);
    expect(p.purchaseDate.equals(Temporal.PlainDate.from("2024-11-30"))).toBe(true);
    expect(p.purchasePricePerShare).toBe(24.88);
    expect(p.fmvPerShareAtPurchase).toBe(70.01);
    expect(p.shares).toBe(389);
  });

  it("parses ESPP Sale transactions", () => {
    const files = makeFiles({
      "Awards.json": awardsJson,
      "Transactions.json": esppTransactions,
    });
    const result = schwab.import(files);
    expect(result.esppSales).toHaveLength(1);

    const s = result.esppSales![0];
    expect(s.purchaseId).toBe("ESPP-06/01/2024-11/30/2024");
    expect(s.saleDate.equals(Temporal.PlainDate.from("2024-12-03"))).toBe(true);
    expect(s.salePricePerShare).toBe(70.4);
    expect(s.shares).toBe(389);
    expect(s.dispositionType).toBe("DISQUALIFIED");
  });

  it("preserves qualified and disqualified disposition labels", () => {
    const mixedEsppTransactions = {
      Transactions: [
        {
          Date: "06/02/2025",
          Action: "Sale",
          Symbol: "XYZ",
          Quantity: "340",
          Description: "Share Sale",
          TransactionDetails: [
            {
              Details: {
                Type: "ESPP",
                Shares: "340",
                SalePrice: "$52.79",
                SubscriptionDate: "12/01/2022",
                SubscriptionFairMarketValue: "$14.41",
                PurchaseDate: "05/31/2023",
                PurchasePrice: "$12.2485",
                PurchaseFairMarketValue: "$14.86",
                DispositionType: "QUALIFIED",
              },
            },
          ],
        },
        esppTransactions.Transactions[1],
      ],
    };

    const files = makeFiles({
      "Awards.json": awardsJson,
      "Transactions.json": mixedEsppTransactions,
    });
    const result = schwab.import(files);

    expect(result.esppSales).toHaveLength(2);
    expect(result.esppSales!.map((sale) => sale.dispositionType)).toEqual([
      "DISQUALIFIED",
      "QUALIFIED",
    ]);
  });

  it("does not confuse ESPP transactions with RSU lapses", () => {
    const mixedTx = {
      Transactions: [...transactionsJson.Transactions, ...esppTransactions.Transactions],
    };
    const files = makeFiles({
      "Awards.json": awardsJson,
      "Transactions.json": mixedTx,
    });
    const result = schwab.import(files);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].vests).toHaveLength(2);
    expect(result.esppPurchases).toHaveLength(1);
    expect(result.esppSales).toHaveLength(1);
  });

  it("returns undefined for ESPP fields when no ESPP transactions exist", () => {
    const rsuOnlyTx = {
      Transactions: [transactionsJson.Transactions[0], transactionsJson.Transactions[1]],
    };
    const files = makeFiles({
      "Awards.json": awardsJson,
      "Transactions.json": rsuOnlyTx,
    });
    const result = schwab.import(files);
    expect(result.esppPurchases).toBeUndefined();
    expect(result.esppSales).toBeUndefined();
  });
});
