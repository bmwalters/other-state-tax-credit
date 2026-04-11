import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { countWorkingDaysByLocation, isWeekday } from "../src/workdays.ts";
import { buildStateRulesConfig } from "../src/state-rules.ts";
import type { NonWorkingInterval, WorkInterval } from "../src/types.ts";

function pd(s: string) {
  return Temporal.PlainDate.from(s);
}

/**
 * Build a StateRulesConfig with no residence rules but with reporting
 * events for every location so the de minimis rule doesn't suppress them.
 */
function emptyRules(workIntervals: WorkInterval[], nonWorkingIntervals: NonWorkingInterval[] = []) {
  const years = new Set(workIntervals.flatMap((wi) => [wi.start.year, wi.end.year]));
  const locations = new Set(workIntervals.map((wi) => wi.location));
  const reportingEvents = [...years].flatMap((year) =>
    [...locations].map((state) => ({ year, state })),
  );
  return buildStateRulesConfig(workIntervals, nonWorkingIntervals, [], [], reportingEvents);
}

describe("isWeekday", () => {
  it("returns true for Mon–Fri", () => {
    // 2024-01-01 is Monday
    expect(isWeekday(pd("2024-01-01"))).toBe(true); // Mon
    expect(isWeekday(pd("2024-01-02"))).toBe(true); // Tue
    expect(isWeekday(pd("2024-01-03"))).toBe(true); // Wed
    expect(isWeekday(pd("2024-01-04"))).toBe(true); // Thu
    expect(isWeekday(pd("2024-01-05"))).toBe(true); // Fri
  });

  it("returns false for Sat–Sun", () => {
    expect(isWeekday(pd("2024-01-06"))).toBe(false); // Sat
    expect(isWeekday(pd("2024-01-07"))).toBe(false); // Sun
  });
});

describe("countWorkingDaysByLocation", () => {
  it("allocates all working days to single location", () => {
    // Mon Jan 1 – Fri Jan 5 = 5 weekdays, all in NY
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      workIntervals,
      [],
      emptyRules(workIntervals),
    );
    expect(result.totalWorkingDays).toBe(5);
    expect(result.daysByLocation["US-NY"]).toBe(5);
  });

  it("splits days across two locations", () => {
    // Mon Jan 1 – Fri Jan 5: NY
    // Mon Jan 8 – Fri Jan 12: CA
    // Window: Jan 1 – Jan 12 (Fri) → 10 weekdays
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-07"), location: "US-NY" },
      { start: pd("2024-01-08"), end: pd("2024-01-14"), location: "US-CA" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-14"),
      workIntervals,
      [],
      emptyRules(workIntervals),
    );
    expect(result.totalWorkingDays).toBe(10);
    expect(result.daysByLocation["US-NY"]).toBe(5);
    expect(result.daysByLocation["US-CA"]).toBe(5);
  });

  it("excludes holidays from both numerator and denominator", () => {
    // Mon Jan 1 is a holiday; Tue–Fri = 4 weekdays
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" },
    ];
    const nonWorking: NonWorkingInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-01"), category: "holiday" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      workIntervals,
      nonWorking,
      emptyRules(workIntervals, nonWorking),
    );
    expect(result.totalWorkingDays).toBe(4);
    expect(result.daysByLocation["US-NY"]).toBe(4);
  });

  it("excludes multi-day non-working interval", () => {
    // Jan 1–5 in NY, but Jan 3–4 (Wed–Thu) are vacation
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" },
    ];
    const nonWorking: NonWorkingInterval[] = [
      { start: pd("2024-01-03"), end: pd("2024-01-04"), category: "vacation" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      workIntervals,
      nonWorking,
      emptyRules(workIntervals, nonWorking),
    );
    // Mon, Tue, Fri = 3 working days
    expect(result.totalWorkingDays).toBe(3);
    expect(result.daysByLocation["US-NY"]).toBe(3);
  });

  it("includes the endpoint dates (inclusive interval)", () => {
    // Window is exactly Mon Jan 1 to Mon Jan 1 = 1 weekday
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-01"), location: "US-NY" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-01"),
      workIntervals,
      [],
      emptyRules(workIntervals),
    );
    expect(result.totalWorkingDays).toBe(1);
    expect(result.daysByLocation["US-NY"]).toBe(1);
  });

  it("includes the vest/end date when it is a weekday", () => {
    // Window: Mon Jan 1 – Fri Jan 5 → 5 weekdays (Fri is included)
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      workIntervals,
      [],
      emptyRules(workIntervals),
    );
    expect(result.totalWorkingDays).toBe(5);
  });

  it("throws on overlapping work intervals", () => {
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" },
      { start: pd("2024-01-03"), end: pd("2024-01-07"), location: "US-CA" },
    ];
    expect(() =>
      countWorkingDaysByLocation(
        pd("2024-01-01"),
        pd("2024-01-07"),
        workIntervals,
        [],
        emptyRules(workIntervals),
      ),
    ).toThrow(/Overlapping work intervals/);
  });

  it("treats uncovered working days as unattributed", () => {
    // Only cover Mon–Wed, but window goes to Fri.
    // Thu/Fri still count in the denominator, but not in any location bucket.
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-03"), location: "US-NY" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      workIntervals,
      [],
      emptyRules(workIntervals),
    );
    expect(result.totalWorkingDays).toBe(5);
    expect(result.daysByLocation["US-NY"]).toBe(3);
  });

  it("does not throw when uncovered days are weekends", () => {
    // Work interval ends Fri; window ends Sun. Sat+Sun are weekends, not working days.
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-07"),
      workIntervals,
      [],
      emptyRules(workIntervals),
    );
    expect(result.totalWorkingDays).toBe(5);
  });

  it("does not throw when uncovered weekdays are non-working", () => {
    // Gap on Thu Jan 4, but it's marked as a holiday
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-03"), location: "US-NY" },
      { start: pd("2024-01-05"), end: pd("2024-01-05"), location: "US-NY" },
    ];
    const nonWorking: NonWorkingInterval[] = [
      { start: pd("2024-01-04"), end: pd("2024-01-04"), category: "holiday" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      workIntervals,
      nonWorking,
      emptyRules(workIntervals, nonWorking),
    );
    expect(result.totalWorkingDays).toBe(4);
    expect(result.daysByLocation["US-NY"]).toBe(4);
  });

  it("clips work intervals to the allocation window", () => {
    // Work interval is much wider than the allocation window
    const workIntervals: WorkInterval[] = [
      { start: pd("2023-01-01"), end: pd("2025-12-31"), location: "US-NY" },
    ];
    // Window: Mon Jan 1 – Fri Jan 5, 2024 = 5 weekdays
    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      workIntervals,
      [],
      emptyRules(workIntervals),
    );
    expect(result.totalWorkingDays).toBe(5);
    expect(result.daysByLocation["US-NY"]).toBe(5);
  });

  it("handles zero-length window on a weekend (0 working days)", () => {
    // Sat Jan 6 to Sat Jan 6
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-07"), location: "US-NY" },
    ];
    const result = countWorkingDaysByLocation(
      pd("2024-01-06"),
      pd("2024-01-06"),
      workIntervals,
      [],
      emptyRules(workIntervals),
    );
    expect(result.totalWorkingDays).toBe(0);
  });

  it("overlapping same-location intervals still throw", () => {
    // Even if both intervals claim NY, overlap is still an error (double-counting guard)
    const workIntervals: WorkInterval[] = [
      { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" },
      { start: pd("2024-01-05"), end: pd("2024-01-07"), location: "US-NY" },
    ];
    expect(() =>
      countWorkingDaysByLocation(
        pd("2024-01-01"),
        pd("2024-01-07"),
        workIntervals,
        [],
        emptyRules(workIntervals),
      ),
    ).toThrow(/Overlapping work intervals/);
  });
});
