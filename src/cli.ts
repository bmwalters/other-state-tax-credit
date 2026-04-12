import { loadDirectory } from "./input/index.ts";
import { computeAllocations, computeSalaryAllocations } from "./engine.ts";
import type {
  EsppSaleAllocation,
  SalaryAllocation,
  TaxYearSummary,
  VestAllocation,
} from "./types.ts";
import { NO_INCOME_TAX_STATES } from "./state-rules.ts";

function formatDollar(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Data helpers ────────────────────────────────────────────────────

/** Collect all states that have any claim in a tax year (summary + salary). */
function allClaimingStates(
  summary: TaxYearSummary,
  salary: SalaryAllocation | undefined,
): string[] {
  const states = new Set<string>();
  for (const s of Object.keys(summary.totalResidentIncomeByState)) states.add(s);
  for (const s of Object.keys(summary.totalNonresidentIncomeByState)) states.add(s);
  if (salary) {
    for (const s of Object.keys(salary.residentDaysByState)) states.add(s);
    for (const s of Object.keys(salary.nonresidentDaysByState)) states.add(s);
  }
  return [...states].sort();
}

/** Filing status label for a state in a given year. */
function filingStatus(
  state: string,
  summary: TaxYearSummary,
  salary: SalaryAllocation | undefined,
): string {
  if (NO_INCOME_TAX_STATES.has(state)) return "No income tax";

  const hasResident =
    (summary.totalResidentIncomeByState[state] ?? 0) !== 0 ||
    (salary?.residentDaysByState[state] ?? 0) > 0;
  const hasNonresident =
    (summary.totalNonresidentIncomeByState[state] ?? 0) !== 0 ||
    (salary?.nonresidentDaysByState[state] ?? 0) > 0;

  if (hasResident && hasNonresident) return "Part-Year Resident";
  if (hasResident) return "Resident";
  return "Nonresident";
}

/** Sum resident + nonresident RSU income for a state across all vests. */
function vestResidentIncome(vests: VestAllocation[], state: string): number {
  return vests.reduce((s, v) => s + (v.residentIncomeByState[state] ?? 0), 0);
}
function vestNonresidentIncome(vests: VestAllocation[], state: string): number {
  return vests.reduce((s, v) => s + (v.nonresidentIncomeByState[state] ?? 0), 0);
}

/** Sum resident + nonresident ESPP income for a state across all sales. */
function esppResidentIncome(sales: EsppSaleAllocation[], state: string): number {
  return sales.reduce((s, e) => s + (e.residentOrdinaryIncomeByState[state] ?? 0), 0);
}
function esppNonresidentIncome(sales: EsppSaleAllocation[], state: string): number {
  return sales.reduce((s, e) => s + (e.nonresidentOrdinaryIncomeByState[state] ?? 0), 0);
}

// ── Per-state section ───────────────────────────────────────────────

function printStateSection(
  state: string,
  summary: TaxYearSummary,
  salary: SalaryAllocation | undefined,
): void {
  const status = filingStatus(state, summary, salary);
  console.log(`\n--- ${state} (${status}) ---`);

  if (NO_INCOME_TAX_STATES.has(state)) {
    console.log("  No filing required.");
    return;
  }

  // Salary
  if (salary) {
    const resDays = salary.residentDaysByState[state] ?? 0;
    const nrDays = salary.nonresidentDaysByState[state] ?? 0;
    const totalDays = resDays + nrDays;
    if (totalDays > 0) {
      const parts: string[] = [];
      if (resDays > 0) parts.push(`${resDays} resident`);
      if (nrDays > 0) parts.push(`${nrDays} nonresident`);
      console.log(
        `  Salary/wages:  ${totalDays} / ${salary.totalDays} days  (${parts.join(" + ")})`,
      );
    }
  }

  // RSU vests
  const rsuRes = vestResidentIncome(summary.vestAllocations, state);
  const rsuNr = vestNonresidentIncome(summary.vestAllocations, state);
  if (rsuRes > 0 || rsuNr > 0) {
    if (rsuRes > 0) console.log(`  RSU vests (resident):               ${formatDollar(rsuRes)}`);
    if (rsuNr > 0) console.log(`  RSU vests (nonresident source):      ${formatDollar(rsuNr)}`);
  }

  // ESPP sales
  const esppRes = esppResidentIncome(summary.esppSaleAllocations, state);
  const esppNr = esppNonresidentIncome(summary.esppSaleAllocations, state);
  if (esppRes > 0 || esppNr > 0) {
    if (esppRes > 0) console.log(`  ESPP sales (resident):              ${formatDollar(esppRes)}`);
    if (esppNr > 0) console.log(`  ESPP sales (nonresident source):     ${formatDollar(esppNr)}`);
  }
}

// ── OSTC section ────────────────────────────────────────────────────

interface OstcEntry {
  residentState: string;
  nonresidentState: string;
  salaryDays: number;
  salaryTotalDays: number;
  rsuIncome: number;
  esppIncome: number;
}

function computeOstcEntries(
  summary: TaxYearSummary,
  salary: SalaryAllocation | undefined,
): OstcEntry[] {
  // For each (residentState, nonresidentState) pair, compute the
  // income that nonresidentState taxed on events where residentState
  // was the taxpayer's resident state.

  const map = new Map<string, OstcEntry>(); // key = "res|nr"

  function getEntry(res: string, nr: string): OstcEntry {
    const key = `${res}|${nr}`;
    if (!map.has(key)) {
      map.set(key, {
        residentState: res,
        nonresidentState: nr,
        salaryDays: 0,
        salaryTotalDays: salary?.totalDays ?? 0,
        rsuIncome: 0,
        esppIncome: 0,
      });
    }
    return map.get(key)!;
  }

  // RSU: for each vest, cross-reference resident states with nonresident states
  for (const va of summary.vestAllocations) {
    for (const resState of Object.keys(va.residentIncomeByState)) {
      for (const [nrState, nrIncome] of Object.entries(va.nonresidentIncomeByState)) {
        getEntry(resState, nrState).rsuIncome += nrIncome;
      }
    }
  }

  // ESPP: same pattern
  for (const ea of summary.esppSaleAllocations) {
    for (const resState of Object.keys(ea.residentOrdinaryIncomeByState)) {
      for (const [nrState, nrIncome] of Object.entries(ea.nonresidentOrdinaryIncomeByState)) {
        getEntry(resState, nrState).esppIncome += nrIncome;
      }
    }
  }

  // Salary: use crossStateSourceDays
  if (salary) {
    for (const [resState, sources] of Object.entries(salary.crossStateSourceDays)) {
      for (const [nrState, days] of Object.entries(sources)) {
        getEntry(resState, nrState).salaryDays += days;
      }
    }
  }

  return [...map.values()].filter((e) => e.salaryDays > 0 || e.rsuIncome > 0 || e.esppIncome > 0);
}

function printOstcSection(entries: OstcEntry[]): void {
  if (entries.length === 0) return;

  console.log("\n--- Other-State Tax Credit (OSTC) ---");

  // Group by resident state
  const byResident = new Map<string, OstcEntry[]>();
  for (const e of entries) {
    if (!byResident.has(e.residentState)) byResident.set(e.residentState, []);
    byResident.get(e.residentState)!.push(e);
  }

  for (const [resState, stateEntries] of [...byResident.entries()].sort()) {
    for (const e of stateEntries.sort((a, b) =>
      a.nonresidentState.localeCompare(b.nonresidentState),
    )) {
      console.log(`\n  On ${resState} return, credit for taxes paid to ${e.nonresidentState}:`);
      if (e.salaryDays > 0) console.log(`    Salary:  ${e.salaryDays} / ${e.salaryTotalDays} days`);
      if (e.rsuIncome > 0) console.log(`    RSU:     ${formatDollar(e.rsuIncome)}`);
      if (e.esppIncome > 0) console.log(`    ESPP:    ${formatDollar(e.esppIncome)}`);
    }
  }
}

// ── Detail tables (behind --detail flag) ────────────────────────────

function printDetailTables(summary: TaxYearSummary): void {
  const locations = allClaimingStates(summary);
  if (locations.length === 0) return;

  if (summary.vestAllocations.length > 0) {
    console.log("\n  [Detail] RSU Vests:");
    for (const va of summary.vestAllocations) {
      const locParts = locations
        .map((l) => {
          const inc = (va.residentIncomeByState[l] ?? 0) + (va.nonresidentIncomeByState[l] ?? 0);
          if (inc === 0) return null;
          const tag = va.residentIncomeByState[l] ? "res" : "nr";
          return `${l}=${formatDollar(inc)} (${tag})`;
        })
        .filter(Boolean)
        .join("  ");
      console.log(
        `    ${va.grantId.padEnd(10)} ${va.vestDate.toString()} ${String(va.shares).padStart(6)} × ${formatDollar(va.fmvPerShare).padStart(8)} = ${formatDollar(va.income).padStart(12)}  ${locParts}`,
      );
    }
  }

  if (summary.esppSaleAllocations.length > 0) {
    console.log("\n  [Detail] ESPP Sales:");
    for (const ea of summary.esppSaleAllocations) {
      const locParts = locations
        .map((l) => {
          const inc =
            (ea.residentOrdinaryIncomeByState[l] ?? 0) +
            (ea.nonresidentOrdinaryIncomeByState[l] ?? 0);
          if (inc === 0) return null;
          const tag = ea.residentOrdinaryIncomeByState[l] ? "res" : "nr";
          return `${l}=${formatDollar(inc)} (${tag})`;
        })
        .filter(Boolean)
        .join("  ");
      console.log(
        `    ${ea.purchaseId.padEnd(34)} ${ea.saleDate.toString()} ${String(ea.shares).padStart(6)} ord=${formatDollar(ea.ordinaryIncome).padStart(10)}  ${locParts}`,
      );
    }
  }
}

// ── Main output ─────────────────────────────────────────────────────

function printYear(
  summary: TaxYearSummary,
  salary: SalaryAllocation | undefined,
  showDetail: boolean,
): void {
  const states = allClaimingStates(summary, salary);
  if (states.length === 0) return;

  console.log(`\n=== Tax Year ${summary.taxYear} ===`);

  for (const state of states) {
    printStateSection(state, summary, salary);
  }

  const ostcEntries = computeOstcEntries(summary, salary);
  printOstcSection(ostcEntries);

  if (showDetail) {
    printDetailTables(summary);
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
const showDetail = args.includes("--detail");
const filteredArgs = args.filter((a) => a !== "--detail");

const dirPath = filteredArgs[0];
if (!dirPath) {
  console.error("usage: node cli.ts <data-directory> [--detail]");
  process.exit(1);
}

printWarnings();
const input = loadDirectory(dirPath);
const summaries = computeAllocations(input);
const salaryAllocations = computeSalaryAllocations(input);

// Index salary allocations by year for easy lookup
const salaryByYear = new Map<number, SalaryAllocation>();
for (const sa of salaryAllocations) {
  salaryByYear.set(sa.year, sa);
}

// Print years that appear in either summaries or salary allocations
const allYears = new Set<number>();
for (const s of summaries) allYears.add(s.taxYear);
for (const sa of salaryAllocations) allYears.add(sa.year);

const summaryByYear = new Map<number, TaxYearSummary>();
for (const s of summaries) summaryByYear.set(s.taxYear, s);

for (const year of [...allYears].sort()) {
  const summary = summaryByYear.get(year) ?? {
    taxYear: year,
    vestAllocations: [],
    esppSaleAllocations: [],
    weightedFractionByLocation: {},
    totalShares: 0,
    totalIncome: 0,
    totalResidentIncomeByState: {},
    totalNonresidentIncomeByState: {},
  };
  printYear(summary, salaryByYear.get(year), showDetail);
}
