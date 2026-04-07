import { describe, expect, it } from "vitest";
import { parseInterval } from "../../../src/input/util/date.ts";

describe("parseInterval", () => {
  it("parses date/date intervals", () => {
    const { start, end } = parseInterval("2024-01-01/2024-07-01");
    expect(start.toString()).toBe("2024-01-01");
    expect(end.toString()).toBe("2024-07-01");
  });

  it("parses date/duration intervals", () => {
    const { start, end } = parseInterval("2024-01-01/P6M");
    expect(start.toString()).toBe("2024-01-01");
    expect(end.toString()).toBe("2024-07-01");
  });

  it("parses duration/date intervals", () => {
    const { start, end } = parseInterval("P6M/2024-07-01");
    expect(start.toString()).toBe("2024-01-01");
    expect(end.toString()).toBe("2024-07-01");
  });

  it("parses date/duration with days", () => {
    const { start, end } = parseInterval("2024-03-01/P30D");
    expect(start.toString()).toBe("2024-03-01");
    expect(end.toString()).toBe("2024-03-31");
  });

  it("parses date/duration with years, months, and days", () => {
    const { start, end } = parseInterval("2023-01-15/P1Y2M10D");
    expect(start.toString()).toBe("2023-01-15");
    expect(end.toString()).toBe("2024-03-25");
  });

  it("parses date/duration with weeks", () => {
    const { start, end } = parseInterval("2024-01-01/P2W");
    expect(start.toString()).toBe("2024-01-01");
    expect(end.toString()).toBe("2024-01-15");
  });

  it("parses duration/date with complex duration", () => {
    const { start, end } = parseInterval("P1Y6M/2025-07-01");
    expect(start.toString()).toBe("2024-01-01");
    expect(end.toString()).toBe("2025-07-01");
  });

  it("throws on missing slash", () => {
    expect(() => parseInterval("2024-01-01")).toThrow('missing "/"');
  });

  it("throws on empty sides", () => {
    expect(() => parseInterval("/2024-01-01")).toThrow("malformed interval");
    expect(() => parseInterval("2024-01-01/")).toThrow("malformed interval");
  });

  it("throws when both sides are durations", () => {
    expect(() => parseInterval("P1Y/P6M")).toThrow("both sides are durations");
  });

  it("handles signed durations (ISO 8601-2 extension)", () => {
    const { start, end } = parseInterval("2024-07-01/+P6M");
    expect(start.toString()).toBe("2024-07-01");
    expect(end.toString()).toBe("2025-01-01");
  });
});
