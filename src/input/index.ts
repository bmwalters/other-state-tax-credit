import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Brokerage,
  DomicileInterval,
  FileMap,
  InputData,
  NonWorkingInterval,
  ReportingEvent,
  StatutoryResidence,
  WorkInterval,
} from "../types.ts";
import { schwab } from "./brokerage/schwab.ts";
import { parseInterval } from "./util/date.ts";

const brokerages: Brokerage[] = [schwab];

function parseWorkLocation(content: string): WorkInterval[] {
  const lines = content.trim().split("\n");
  const header = lines[0];
  if (!header || !header.includes("interval")) {
    throw new Error("work-location.csv: missing 'interval' header");
  }

  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [interval, location] = line.split(",").map((s) => s.trim());
      if (!interval || !location) {
        throw new Error(`work-location.csv: malformed line: ${line}`);
      }
      const { start, end } = parseInterval(interval);
      return { start, end, location };
    });
}

function parseHolidays(content: string): NonWorkingInterval[] {
  const lines = content.trim().split("\n");
  const header = lines[0];
  if (!header || !header.includes("interval")) {
    throw new Error("holidays.csv: missing 'interval' header");
  }

  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [interval, category] = line.split(",").map((s) => s.trim());
      if (!interval || !category) {
        throw new Error(`holidays.csv: malformed line: ${line}`);
      }
      const { start, end } = parseInterval(interval);
      return { start, end, category };
    });
}

/**
 * Parse reporting-events.csv.
 *
 * Format:
 *   year,state
 *   2024,US-NY
 *   2024,US-CA
 */
function parseReportingEvents(content: string): ReportingEvent[] {
  const lines = content.trim().split("\n");
  const header = lines[0];
  if (!header || !header.includes("year")) {
    throw new Error("reporting-events.csv: missing 'year' header");
  }

  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [yearStr, state] = line.split(",").map((s) => s.trim());
      if (!yearStr || !state) {
        throw new Error(`reporting-events.csv: malformed line: ${line}`);
      }
      const year = Number(yearStr);
      if (!Number.isFinite(year)) {
        throw new Error(`reporting-events.csv: invalid year: ${yearStr}`);
      }
      return { year, state };
    });
}

/**
 * Parse domicile.csv.
 *
 * Format:
 *   interval,state
 *   2024-01-01/2024-06-30,US-NY
 *   2024-07-01/2024-12-31,US-CA
 */
function parseDomicile(content: string): DomicileInterval[] {
  const lines = content.trim().split("\n");
  const header = lines[0];
  if (!header || !header.includes("interval")) {
    throw new Error("domicile.csv: missing 'interval' header");
  }

  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [interval, state] = line.split(",").map((s) => s.trim());
      if (!interval || !state) {
        throw new Error(`domicile.csv: malformed line: ${line}`);
      }
      const { start, end } = parseInterval(interval);
      return { start, end, state };
    });
}

/**
 * Parse statutory-residence.csv.
 *
 * Format:
 *   year,state
 *   2025,US-NY
 */
function parseStatutoryResidence(content: string): StatutoryResidence[] {
  const lines = content.trim().split("\n");
  const header = lines[0];
  if (!header || !header.includes("year")) {
    throw new Error("statutory-residence.csv: missing 'year' header");
  }

  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [yearStr, state] = line.split(",").map((s) => s.trim());
      if (!yearStr || !state) {
        throw new Error(`statutory-residence.csv: malformed line: ${line}`);
      }
      const year = Number(yearStr);
      if (!Number.isFinite(year)) {
        throw new Error(`statutory-residence.csv: invalid year: ${yearStr}`);
      }
      return { year, state };
    });
}

export function loadDirectory(dirPath: string): InputData {
  const dirEntries = readdirSync(dirPath);

  const files: Map<string, string> = new Map();
  let workIntervals: WorkInterval[] | undefined;
  let nonWorkingIntervals: NonWorkingInterval[] = [];
  let reportingEvents: ReportingEvent[] = [];
  let domicileIntervals: DomicileInterval[] | undefined;
  let statutoryResidences: StatutoryResidence[] = [];

  for (const name of dirEntries) {
    const fullPath = join(dirPath, name);
    const content = readFileSync(fullPath, "utf-8");

    if (name === "work-location.csv") {
      workIntervals = parseWorkLocation(content);
    } else if (name === "holidays.csv") {
      nonWorkingIntervals = parseHolidays(content);
    } else if (name === "reporting-events.csv") {
      reportingEvents = parseReportingEvents(content);
    } else if (name === "domicile.csv") {
      domicileIntervals = parseDomicile(content);
    } else if (name === "statutory-residence.csv") {
      statutoryResidences = parseStatutoryResidence(content);
    } else {
      files.set(name, content);
    }
  }

  if (!workIntervals) {
    throw new Error("work-location.csv not found in data directory");
  }
  if (!domicileIntervals) {
    throw new Error("domicile.csv not found in data directory");
  }

  const fileMap: FileMap = files;
  for (const brokerage of brokerages) {
    if (brokerage.canImport(fileMap)) {
      const result = brokerage.import(fileMap);
      return {
        grants: result.grants,
        esppPurchases: result.esppPurchases,
        esppSales: result.esppSales,
        workIntervals,
        nonWorkingIntervals,
        reportingEvents,
        domicileIntervals,
        statutoryResidences,
      };
    }
  }

  throw new Error("No brokerage recognized the files in the data directory");
}
