import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Temporal } from "temporal-polyfill";
import type { Brokerage, Grant, InputData, WorkInterval } from "../types.ts";
import { schwab } from "./brokerage/schwab.ts";
import { parseInterval } from "./util/date.ts";

const brokerages: Brokerage[] = [schwab];

function parseWorkLocation(content: string): WorkInterval[] {
  const lines = content.trim().split("\n");
  const header = lines[0];
  if (!header || !header.includes("interval")) {
    throw new Error("work-location.csv: missing 'interval' header");
  }

  return lines.slice(1).filter(Boolean).map((line) => {
    const [interval, location] = line.split(",").map((s) => s.trim());
    if (!interval || !location) {
      throw new Error(`work-location.csv: malformed line: ${line}`);
    }
    const { start, end } = parseInterval(interval);
    return { start, end, location };
  });
}

export function loadDirectory(dirPath: string): InputData {
  const files = readdirSync(dirPath);
  let workIntervals: WorkInterval[] | undefined;
  const allGrants: Grant[] = [];

  for (const file of files) {
    const fullPath = join(dirPath, file);

    if (file === "work-location.csv") {
      const content = readFileSync(fullPath, "utf-8");
      workIntervals = parseWorkLocation(content);
      continue;
    }

    const content = readFileSync(fullPath, "utf-8");
    for (const brokerage of brokerages) {
      if (brokerage.canImport(file, content)) {
        allGrants.push(...brokerage.import(file, content));
        break;
      }
    }
  }

  if (!workIntervals) {
    throw new Error("work-location.csv not found in data directory");
  }

  return { grants: allGrants, workIntervals };
}
