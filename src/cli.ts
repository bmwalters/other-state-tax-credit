import { loadDirectory } from "./input/index.ts";
import { computeAllocations } from "./engine.ts";
import type { TaxYearSummary } from "./types.ts";

function formatPercent(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

function formatDollar(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printSummary(summaries: TaxYearSummary[]): void {
  for (const summary of summaries) {
    const locations = Object.keys(summary.weightedFractionByLocation);

    console.log(`\n=== Tax Year ${summary.taxYear} ===`);

    const header =
      `${"Grant".padEnd(10)} ${"Vest Date".padEnd(12)} ${"Shares".padStart(8)} ${"FMV".padStart(10)} ${"Income".padStart(14)}  ` +
      locations.map((l) => `${(l + " %").padStart(10)} ${(l + " $").padStart(14)}`).join("  ");
    console.log(header);
    console.log("-".repeat(header.length));

    for (const va of summary.vestAllocations) {
      const locCols = locations
        .map(
          (l) =>
            `${formatPercent(va.fractionByLocation[l] ?? 0).padStart(10)} ${formatDollar(va.incomeByLocation[l] ?? 0).padStart(14)}`,
        )
        .join("  ");
      console.log(
        `${va.grantId.padEnd(10)} ${va.vestDate.toString().padEnd(12)} ${String(va.shares).padStart(8)} ${formatDollar(va.fmvPerShare).padStart(10)} ${formatDollar(va.income).padStart(14)}  ${locCols}`,
      );
    }

    console.log("-".repeat(header.length));

    const totalLocCols = locations
      .map(
        (l) =>
          `${formatPercent(summary.weightedFractionByLocation[l] ?? 0).padStart(10)} ${formatDollar(summary.totalIncomeByLocation[l] ?? 0).padStart(14)}`,
      )
      .join("  ");
    console.log(
      `${"TOTAL".padEnd(10)} ${"".padEnd(12)} ${String(summary.totalShares).padStart(8)} ${"".padStart(10)} ${formatDollar(summary.totalIncome).padStart(14)}  ${totalLocCols}`,
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
