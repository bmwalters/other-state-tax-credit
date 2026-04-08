import { Temporal } from "temporal-polyfill";
import type { Brokerage, FileMap, Grant, Vest } from "../../types.ts";

interface SchwabAward {
  awardId: number;
  awardName: string;
  awardDate: string;
  awardType: string;
  symbol: string;
}

interface SchwabAwardsJson {
  awardsDetail: {
    restrictedStockUnits: SchwabAward[];
  };
}

interface SchwabLapseDetails {
  AwardDate: string;
  AwardId: string;
  FairMarketValuePrice: string;
}

interface SchwabTransaction {
  Date: string;
  Action: string;
  Symbol: string;
  Quantity: string | null;
  TransactionDetails: { Details: SchwabLapseDetails }[];
}

interface SchwabTransactionsJson {
  Transactions: SchwabTransaction[];
}

function parseIsoDate(s: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(s.slice(0, 10));
}

function parseMdyDate(s: string): Temporal.PlainDate {
  const [mm, dd, yyyy] = s.split("/");
  return Temporal.PlainDate.from(`${yyyy}-${mm}-${dd}`);
}

function parseDollar(s: string): number {
  return Number(s.replace(/[$,]/g, ""));
}

function findAwardsFile(files: FileMap): string | undefined {
  for (const [name, content] of files) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(content);
      if (data?.awardsDetail?.restrictedStockUnits != null) return name;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

function findTransactionsFiles(files: FileMap): string[] {
  const result: string[] = [];
  for (const [name, content] of files) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data?.Transactions)) result.push(name);
    } catch {
      /* skip */
    }
  }
  return result;
}

export const schwab: Brokerage = {
  canImport(files: FileMap): boolean {
    return findAwardsFile(files) != null && findTransactionsFiles(files).length > 0;
  },

  import(files: FileMap): Grant[] {
    const awardsFileName = findAwardsFile(files);
    if (!awardsFileName) throw new Error("Schwab Awards JSON not found");

    const awardsData: SchwabAwardsJson = JSON.parse(files.get(awardsFileName)!);
    const txFileNames = findTransactionsFiles(files);
    if (txFileNames.length === 0) throw new Error("Schwab Transactions JSON not found");

    const awardMeta = new Map<string, { awardDate: Temporal.PlainDate; symbol: string }>();
    for (const award of awardsData.awardsDetail.restrictedStockUnits) {
      if (award.awardType !== "RSU") continue;
      awardMeta.set(award.awardName, {
        awardDate: parseIsoDate(award.awardDate),
        symbol: award.symbol,
      });
    }

    const vestsByAward = new Map<string, Vest[]>();

    for (const txFileName of txFileNames) {
      const txData: SchwabTransactionsJson = JSON.parse(files.get(txFileName)!);
      for (const tx of txData.Transactions) {
        if (tx.Action !== "Lapse") continue;
        if (tx.Quantity == null) continue;
        const detail = tx.TransactionDetails[0]?.Details;
        if (!detail?.FairMarketValuePrice) continue;

        const awardId = detail.AwardId;
        const vest: Vest = {
          date: parseMdyDate(tx.Date),
          shares: Number(tx.Quantity),
          fmvPerShare: parseDollar(detail.FairMarketValuePrice),
        };

        if (!vestsByAward.has(awardId)) vestsByAward.set(awardId, []);
        vestsByAward.get(awardId)!.push(vest);
      }
    }

    const grants: Grant[] = [];
    for (const [awardId, vests] of vestsByAward) {
      const meta = awardMeta.get(awardId);
      if (!meta) {
        throw new Error(`Lapse references unknown award ${awardId} — not found in Awards.json`);
      }

      vests.sort((a, b) => Temporal.PlainDate.compare(a.date, b.date));

      grants.push({
        id: awardId,
        awardDate: meta.awardDate,
        symbol: meta.symbol,
        vests,
      });
    }

    grants.sort(
      (a, b) => Temporal.PlainDate.compare(a.awardDate, b.awardDate) || a.id.localeCompare(b.id),
    );

    return grants;
  },
};
