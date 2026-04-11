import { loadDirectory } from "./input/index.ts";
import { computeAllocations, computeSalaryAllocations } from "./engine.ts";
import type { SalaryAllocation, TaxYearSummary } from "./types.ts";

function formatPercent(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

function formatDollar(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printSummary(summaries: TaxYearSummary[], showDetailVests: boolean): void {
  for (const summary of summaries) {
    const locations = Object.keys(summary.weightedFractionByLocation);

    console.log(`\n=== Tax Year ${summary.taxYear} ===`);

    // ── RSU vest allocations ──
    if (summary.vestAllocations.length > 0) {
      console.log("\n--- RSU Vests ---");
      const header =
        `${"Grant".padEnd(10)} ${"Vest Date".padEnd(12)} ${"Shares".padStart(8)} ${"FMV".padStart(10)} ${"Income".padStart(14)}  ` +
        locations.map((l) => `${(l + " %").padStart(10)} ${(l + " $").padStart(14)}`).join("  ");
      console.log(header);
      console.log("-".repeat(header.length));

      if (showDetailVests) {
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
      }

      // RSU vest totals
      const vestShares = summary.vestAllocations.reduce((s, v) => s + v.shares, 0);
      const vestIncome = summary.vestAllocations.reduce((s, v) => s + v.income, 0);
      const vestIncomeByLocation: Record<string, number> = {};
      for (const va of summary.vestAllocations) {
        for (const [loc, inc] of Object.entries(va.incomeByLocation)) {
          vestIncomeByLocation[loc] = (vestIncomeByLocation[loc] ?? 0) + inc;
        }
      }
      const vestLocCols = locations
        .map(
          (l) =>
            `${formatPercent(vestIncome > 0 ? (vestIncomeByLocation[l] ?? 0) / vestIncome : 0).padStart(10)} ${formatDollar(vestIncomeByLocation[l] ?? 0).padStart(14)}`,
        )
        .join("  ");
      console.log(
        `${"RSU Total".padEnd(10)} ${"".padEnd(12)} ${String(vestShares).padStart(8)} ${"".padStart(10)} ${formatDollar(vestIncome).padStart(14)}  ${vestLocCols}`,
      );
    }

    // ── ESPP sale allocations ──
    if (summary.esppSaleAllocations.length > 0) {
      console.log("\n--- ESPP Sales (Ordinary Income) ---");
      const esppHeader =
        `${"Purchase".padEnd(34)} ${"Sale Date".padEnd(12)} ${"Shares".padStart(8)} ${"Discount".padStart(10)} ${"Ord Income".padStart(14)}  ` +
        locations.map((l) => `${(l + " %").padStart(10)} ${(l + " $").padStart(14)}`).join("  ");
      console.log(esppHeader);
      console.log("-".repeat(esppHeader.length));

      for (const ea of summary.esppSaleAllocations) {
        const locCols = locations
          .map(
            (l) =>
              `${formatPercent(ea.fractionByLocation[l] ?? 0).padStart(10)} ${formatDollar(ea.ordinaryIncomeByLocation[l] ?? 0).padStart(14)}`,
          )
          .join("  ");
        console.log(
          `${ea.purchaseId.padEnd(34)} ${ea.saleDate.toString().padEnd(12)} ${String(ea.shares).padStart(8)} ${formatDollar(ea.discountPerShare).padStart(10)} ${formatDollar(ea.ordinaryIncome).padStart(14)}  ${locCols}`,
        );
      }
    }

    // ── Totals ──
    console.log("");
    const divider =
      `${"".padEnd(10)} ${"".padEnd(12)} ${"".padStart(8)} ${"".padStart(10)} ${"".padStart(14)}  ` +
      locations.map((_l) => `${"".padStart(10)} ${"".padStart(14)}`).join("  ");
    console.log("-".repeat(divider.length));

    const totalLocCols = locations
      .map(
        (l) =>
          `${formatPercent(summary.weightedFractionByLocation[l] ?? 0).padStart(10)} ${formatDollar(summary.totalIncomeByLocation[l] ?? 0).padStart(14)}`,
      )
      .join("  ");
    console.log(
      `${"TOTAL".padEnd(10)} ${"".padEnd(12)} ${String(summary.totalShares).padStart(8)} ${"".padStart(10)} ${formatDollar(summary.totalIncome).padStart(14)}  ${totalLocCols}`,
    );

    // ── Warn if fractions exceed 100% (multi-state exposure) ──
    const totalFraction = Object.values(summary.weightedFractionByLocation).reduce(
      (s, f) => s + f,
      0,
    );
    if (totalFraction > 1.005) {
      console.log(`\n  ** State fractions sum to ${formatPercent(totalFraction)} (>100%).`);
      console.log("     Multiple states claim the same income (domicile + statutory residence +");
      console.log("     non-resident sourcing). Credits may or may not be available.");
    }
  }
}

function printSalaryAllocations(allocations: SalaryAllocation[]): void {
  if (allocations.length === 0) return;

  console.log("\n\n=== Salary Allocation (20 NYCRR §132.18) ===");
  console.log("Apply these fractions to your non-equity W-2 compensation (salary,");
  console.log("bonus, taxable fringe benefits, etc. — excluding the RSU/ESPP ordinary");
  console.log("income reported above).\n");

  const allLocations = [
    ...new Set(allocations.flatMap((a) => Object.keys(a.fractionByLocation))),
  ].sort();

  const header =
    `${"Year".padEnd(6)} ${"Work Days".padStart(10)}  ` +
    allLocations.map((l) => `${(l + " days").padStart(10)} ${(l + " %").padStart(10)}`).join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const a of allocations) {
    const locCols = allLocations
      .map(
        (l) =>
          `${String(a.daysByLocation[l] ?? 0).padStart(10)} ${formatPercent(a.fractionByLocation[l] ?? 0).padStart(10)}`,
      )
      .join("  ");
    console.log(`${String(a.year).padEnd(6)} ${String(a.totalDays).padStart(10)}  ${locCols}`);
  }

  // Warn on multi-state overlap
  for (const a of allocations) {
    const totalFraction = Object.values(a.fractionByLocation).reduce((s, f) => s + f, 0);
    if (totalFraction > 1.005) {
      console.log(
        `\n  ** ${a.year}: fractions sum to ${formatPercent(totalFraction)} — multiple states claim the same days.`,
      );
    }
  }
}

function printWarnings(): void {
  console.log("NOTE: This tool assumes your work-location.csv already reflects NY's rules:");
  console.log('  - "Convenience of the employer" test (20 NYCRR §132.18(a)):');
  console.log("    Days working remotely outside NY for your own convenience (not employer");
  console.log("    necessity) must be reported as NY days.");
  console.log("  - Work-from-home default (IT-203-F line 15):");
  console.log("    Normal work days spent at home are NY days if your office is in NY.");
  console.log("  - Weekday gaps in work-location.csv are treated as non-NY days.");
  console.log("    Overlapping work-location intervals are still errors.");
  console.log("");
}

const args = process.argv.slice(2);
const detailVests = args.includes("--detail-vests");
const filteredArgs = args.filter((a) => a !== "--detail-vests");

const dirPath = filteredArgs[0];
if (!dirPath) {
  console.error("usage: node cli.ts <data-directory> [--detail-vests]");
  process.exit(1);
}

printWarnings();
const input = loadDirectory(dirPath);
const summaries = computeAllocations(input);
const salaryAllocations = computeSalaryAllocations(input);
printSummary(summaries, detailVests);
printSalaryAllocations(salaryAllocations);
