import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Brokerage, FileMap, InputData, WorkInterval } from "../types.ts";
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

export function loadDirectory(dirPath: string): InputData {
  const dirEntries = readdirSync(dirPath);

  const files: Map<string, string> = new Map();
  let workIntervals: WorkInterval[] | undefined;

  for (const name of dirEntries) {
    const fullPath = join(dirPath, name);
    const content = readFileSync(fullPath, "utf-8");

    if (name === "work-location.csv") {
      workIntervals = parseWorkLocation(content);
    } else {
      files.set(name, content);
    }
  }

  if (!workIntervals) {
    throw new Error("work-location.csv not found in data directory");
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
      };
    }
  }

  throw new Error("No brokerage recognized the files in the data directory");
}
