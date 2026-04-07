import { loadDirectory } from "./input/index.ts";
import { computeAllocations } from "./engine.ts";
import type { TaxYearSummary } from "./types.ts";

function formatPercent(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

function printSummary(summaries: TaxYearSummary[]): void {
  for (const summary of summaries) {
    console.log(`\n=== Tax Year ${summary.taxYear} ===`);
    console.log(
      `${"Grant".padEnd(10)} ${"Vest Date".padEnd(12)} ${"Shares".padStart(8)}  ${Object.keys(summary.weightedFractionByLocation).map((l) => (l + " %").padStart(10)).join("  ")}`,
    );
    console.log("-".repeat(40 + Object.keys(summary.weightedFractionByLocation).length * 12));

    for (const va of summary.vestAllocations) {
      const locations = Object.keys(summary.weightedFractionByLocation);
      const fracs = locations
        .map((l) => formatPercent(va.fractionByLocation[l] ?? 0).padStart(10))
        .join("  ");
      console.log(
        `${va.grantId.padEnd(10)} ${va.vestDate.toString().padEnd(12)} ${String(va.shares).padStart(8)}  ${fracs}`,
      );
    }

    const locations = Object.keys(summary.weightedFractionByLocation);
    const summaryFracs = locations
      .map((l) =>
        formatPercent(summary.weightedFractionByLocation[l] ?? 0).padStart(10),
      )
      .join("  ");
    console.log("-".repeat(40 + locations.length * 12));
    console.log(
      `${"TOTAL".padEnd(10)} ${"".padEnd(12)} ${String(summary.totalShares).padStart(8)}  ${summaryFracs}`,
    );
  }
}

const dirPath = process.argv[2];
if (!dirPath) {
  console.error("usage: node cli.ts <data-directory>");
  process.exit(1);
}

const input = loadDirectory(dirPath);
const summaries = computeAllocations(input);
printSummary(summaries);
