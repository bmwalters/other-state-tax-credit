import { Temporal } from "temporal-polyfill";
import type { Brokerage, Grant } from "../../types.ts";

interface SchwabVesting {
  vestDate: string;
  vestAmount: number;
}

interface SchwabAward {
  awardId: number;
  awardName: string;
  awardDate: string;
  awardType: string;
  symbol: string;
  pastVestings?: SchwabVesting[];
  vestingSchedules?: SchwabVesting[];
}

interface SchwabJson {
  awardsDetail: {
    restrictedStockUnits: SchwabAward[];
  };
}

function parseDate(schwabDate: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(schwabDate.slice(0, 10));
}

export const schwab: Brokerage = {
  canImport(filename: string, content: string): boolean {
    if (!filename.endsWith(".json")) return false;
    try {
      const data = JSON.parse(content);
      return data?.awardsDetail?.restrictedStockUnits != null;
    } catch {
      return false;
    }
  },

  import(_filename: string, content: string): Grant[] {
    const data: SchwabJson = JSON.parse(content);
    return data.awardsDetail.restrictedStockUnits
      .filter((a) => a.awardType === "RSU")
      .map((award) => {
        const allVestings = [
          ...(award.pastVestings ?? []),
          ...(award.vestingSchedules ?? []),
        ];
        return {
          id: award.awardName,
          awardDate: parseDate(award.awardDate),
          symbol: award.symbol,
          vests: allVestings.map((v) => ({
            date: parseDate(v.vestDate),
            shares: v.vestAmount,
          })),
        };
      });
  },
};
