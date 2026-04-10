import { Temporal } from "temporal-polyfill";
import type {
  Brokerage,
  BrokerageResult,
  EsppDispositionType,
  EsppPurchase,
  EsppSale,
  FileMap,
  Grant,
  Vest,
} from "../../types.ts";

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

interface SchwabEsppSaleDetails {
  Type: string;
  Shares: string;
  SalePrice: string;
  SubscriptionDate: string;
  SubscriptionFairMarketValue: string;
  PurchaseDate: string;
  PurchasePrice: string;
  PurchaseFairMarketValue: string;
  DispositionType: string;
}

interface SchwabEsppDepositDetails {
  PurchaseDate: string;
  PurchasePrice: string;
  SubscriptionDate: string;
  SubscriptionFairMarketValue: string;
  PurchaseFairMarketValue: string;
}

interface SchwabTransaction {
  Date: string;
  Action: string;
  Symbol: string;
  Quantity: string | null;
  Description: string;
  TransactionDetails: {
    Details: SchwabLapseDetails | SchwabEsppSaleDetails | SchwabEsppDepositDetails;
  }[];
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

function parseDispositionType(s: string | undefined): EsppDispositionType | undefined {
  const value = s?.trim().toUpperCase();
  if (!value) return undefined;
  if (value === "QUALIFIED" || value === "DISQUALIFIED") return value;
  throw new Error(`Unsupported ESPP disposition type: ${s}`);
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

/**
 * Build a stable ID for an ESPP purchase lot from subscription + purchase dates.
 * Each (subscriptionDate, purchaseDate) pair identifies a unique offering period.
 */
function esppPurchaseId(subscriptionDate: string, purchaseDate: string): string {
  return `ESPP-${subscriptionDate}-${purchaseDate}`;
}

export const schwab: Brokerage = {
  canImport(files: FileMap): boolean {
    return findAwardsFile(files) != null && findTransactionsFiles(files).length > 0;
  },

  import(files: FileMap): BrokerageResult {
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
    const esppPurchaseMap = new Map<string, EsppPurchase>();
    const esppSales: EsppSale[] = [];

    for (const txFileName of txFileNames) {
      const txData: SchwabTransactionsJson = JSON.parse(files.get(txFileName)!);
      for (const tx of txData.Transactions) {
        // ── RSU Lapse ──
        if (tx.Action === "Lapse") {
          if (tx.Quantity == null) continue;
          const detail = tx.TransactionDetails[0]?.Details as SchwabLapseDetails | undefined;
          if (!detail?.FairMarketValuePrice) continue;

          const awardId = detail.AwardId;
          const vest: Vest = {
            date: parseMdyDate(tx.Date),
            shares: Number(tx.Quantity),
            fmvPerShare: parseDollar(detail.FairMarketValuePrice),
          };

          if (!vestsByAward.has(awardId)) vestsByAward.set(awardId, []);
          vestsByAward.get(awardId)!.push(vest);
          continue;
        }

        // ── ESPP Deposit (purchase) ──
        if (tx.Action === "Deposit" && tx.Description === "ESPP") {
          if (tx.Quantity == null) continue;
          const detail = tx.TransactionDetails[0]?.Details as SchwabEsppDepositDetails | undefined;
          if (
            !detail?.PurchaseDate ||
            !detail.SubscriptionDate ||
            !detail.PurchasePrice ||
            !detail.SubscriptionFairMarketValue ||
            !detail.PurchaseFairMarketValue
          ) {
            continue;
          }

          const id = esppPurchaseId(detail.SubscriptionDate, detail.PurchaseDate);
          if (!esppPurchaseMap.has(id)) {
            esppPurchaseMap.set(id, {
              id,
              symbol: tx.Symbol,
              offeringStartDate: parseMdyDate(detail.SubscriptionDate),
              fmvPerShareAtGrant: parseDollar(detail.SubscriptionFairMarketValue),
              purchaseDate: parseMdyDate(detail.PurchaseDate),
              purchasePricePerShare: parseDollar(detail.PurchasePrice),
              fmvPerShareAtPurchase: parseDollar(detail.PurchaseFairMarketValue),
              shares: Number(tx.Quantity),
            });
          }
          continue;
        }

        // ── ESPP Sale ──
        if (tx.Action === "Sale") {
          const detail = tx.TransactionDetails[0]?.Details as SchwabEsppSaleDetails | undefined;
          if (!detail || detail.Type !== "ESPP") continue;
          const dispositionType = parseDispositionType(detail.DispositionType);
          if (
            !detail.SubscriptionDate ||
            !detail.SubscriptionFairMarketValue ||
            !detail.PurchaseDate ||
            !detail.PurchasePrice ||
            !detail.PurchaseFairMarketValue ||
            !detail.SalePrice ||
            !detail.Shares ||
            !dispositionType
          ) {
            continue;
          }

          const purchaseId = esppPurchaseId(detail.SubscriptionDate, detail.PurchaseDate);

          // Ensure we have the purchase lot (Sale records carry full purchase info)
          if (!esppPurchaseMap.has(purchaseId)) {
            esppPurchaseMap.set(purchaseId, {
              id: purchaseId,
              symbol: tx.Symbol,
              offeringStartDate: parseMdyDate(detail.SubscriptionDate),
              fmvPerShareAtGrant: parseDollar(detail.SubscriptionFairMarketValue),
              purchaseDate: parseMdyDate(detail.PurchaseDate),
              purchasePricePerShare: parseDollar(detail.PurchasePrice),
              fmvPerShareAtPurchase: parseDollar(detail.PurchaseFairMarketValue),
              shares: Number(detail.Shares),
            });
          }

          esppSales.push({
            purchaseId,
            saleDate: parseMdyDate(tx.Date),
            salePricePerShare: parseDollar(detail.SalePrice),
            shares: Number(detail.Shares),
            dispositionType,
          });
          continue;
        }
      }
    }

    // ── Build RSU grants ──
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

    // ── Build ESPP purchases ──
    const esppPurchases = [...esppPurchaseMap.values()].sort((a, b) =>
      Temporal.PlainDate.compare(a.purchaseDate, b.purchaseDate),
    );

    esppSales.sort((a, b) => Temporal.PlainDate.compare(a.saleDate, b.saleDate));

    return {
      grants,
      esppPurchases: esppPurchases.length > 0 ? esppPurchases : undefined,
      esppSales: esppSales.length > 0 ? esppSales : undefined,
    };
  },
};
