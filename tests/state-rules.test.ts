import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import {
  buildStateRulesConfig,
  computeYearlyDayCounts,
  getDomicileState,
  getStatutoryResidenceStates,
  isDeMinimis,
  isNoIncomeTaxState,
  NO_INCOME_TAX_STATES,
  resolveClaimingStates,
  type StateRulesConfig,
} from "../src/state-rules.ts";
import { countWorkingDaysByLocation } from "../src/workdays.ts";
import { computeAllocations, computeSalaryAllocations } from "../src/engine.ts";
import type { InputData } from "../src/types.ts";

function pd(s: string) {
  return Temporal.PlainDate.from(s);
}

const EMPTY_STATE_RULES = {
  nonWorkingIntervals: [],
  reportingEvents: [],
  domicileIntervals: [],
  statutoryResidences: [],
} as const satisfies Partial<InputData>;

function makeConfig(overrides: Partial<StateRulesConfig> = {}): StateRulesConfig {
  return {
    domicileIntervals: [],
    statutoryResidences: [],
    reportingEvents: [],
    yearlyDayCounts: new Map(),
    ...overrides,
  };
}

// ── NO_INCOME_TAX_STATES ────────────────────────────────────────────

describe("NO_INCOME_TAX_STATES", () => {
  it("contains all nine no-income-tax states", () => {
    const expected = [
      "US-AK",
      "US-FL",
      "US-NV",
      "US-NH",
      "US-SD",
      "US-TN",
      "US-TX",
      "US-WA",
      "US-WY",
    ];
    for (const s of expected) {
      expect(NO_INCOME_TAX_STATES.has(s)).toBe(true);
    }
    expect(NO_INCOME_TAX_STATES.size).toBe(9);
  });

  it("does not contain income-tax states", () => {
    expect(NO_INCOME_TAX_STATES.has("US-NY")).toBe(false);
    expect(NO_INCOME_TAX_STATES.has("US-CA")).toBe(false);
  });
});

// ── isNoIncomeTaxState ──────────────────────────────────────────────

describe("isNoIncomeTaxState", () => {
  it("returns true for no-income-tax states", () => {
    expect(isNoIncomeTaxState("US-TX")).toBe(true);
    expect(isNoIncomeTaxState("US-FL")).toBe(true);
    expect(isNoIncomeTaxState("US-WA")).toBe(true);
  });

  it("returns false for income-tax states", () => {
    expect(isNoIncomeTaxState("US-NY")).toBe(false);
    expect(isNoIncomeTaxState("US-NJ")).toBe(false);
  });
});

// ── isDeMinimis ─────────────────────────────────────────────────────

describe("isDeMinimis", () => {
  it("returns true for taxing state with <5 days and no reporting event", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-NJ": 3 }]]),
    });
    expect(isDeMinimis("US-NJ", 2024, config)).toBe(true);
  });

  it("returns false for taxing state with >=5 days", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-NJ": 5 }]]),
    });
    expect(isDeMinimis("US-NJ", 2024, config)).toBe(false);
  });

  it("returns false when reporting event exists even with <5 days", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-NJ": 3 }]]),
      reportingEvents: [{ year: 2024, state: "US-NJ" }],
    });
    expect(isDeMinimis("US-NJ", 2024, config)).toBe(false);
  });

  it("returns false for no-income-tax states (handled separately)", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-TX": 2 }]]),
    });
    expect(isDeMinimis("US-TX", 2024, config)).toBe(false);
  });

  it("returns true for unknown state with 0 days and no reporting event", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, {}]]),
    });
    expect(isDeMinimis("US-NJ", 2024, config)).toBe(true);
  });
});

// ── computeYearlyDayCounts ──────────────────────────────────────────

describe("computeYearlyDayCounts", () => {
  it("counts work days per location per year", () => {
    const result = computeYearlyDayCounts(
      [
        { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" }, // Mon–Fri = 5
        { start: pd("2024-01-08"), end: pd("2024-01-12"), location: "US-TX" }, // Mon–Fri = 5
      ],
      [],
    );
    expect(result.get(2024)).toEqual({ "US-NY": 5, "US-TX": 5 });
  });

  it("excludes non-working days", () => {
    const result = computeYearlyDayCounts(
      [{ start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" }],
      [{ start: pd("2024-01-01"), end: pd("2024-01-01"), category: "holiday" }],
    );
    expect(result.get(2024)).toEqual({ "US-NY": 4 });
  });

  it("spans multiple years", () => {
    const result = computeYearlyDayCounts(
      [{ start: pd("2024-12-30"), end: pd("2025-01-03"), location: "US-CA" }],
      [],
    );
    // 2024-12-30 Mon, 2024-12-31 Tue = 2 days in 2024
    // 2025-01-01 Wed, 2025-01-02 Thu, 2025-01-03 Fri = 3 days in 2025
    expect(result.get(2024)).toEqual({ "US-CA": 2 });
    expect(result.get(2025)).toEqual({ "US-CA": 3 });
  });
});

// ── getDomicileState ────────────────────────────────────────────────

describe("getDomicileState", () => {
  const intervals = [
    { start: pd("2024-01-01"), end: pd("2024-06-30"), state: "US-NY" },
    { start: pd("2024-07-01"), end: pd("2024-12-31"), state: "US-CA" },
  ];

  it("returns the domicile state for a date within an interval", () => {
    expect(getDomicileState(pd("2024-03-15"), intervals)).toBe("US-NY");
    expect(getDomicileState(pd("2024-09-15"), intervals)).toBe("US-CA");
  });

  it("returns undefined for a date outside all intervals", () => {
    expect(getDomicileState(pd("2023-12-31"), intervals)).toBeUndefined();
  });

  it("handles boundary dates (inclusive)", () => {
    expect(getDomicileState(pd("2024-01-01"), intervals)).toBe("US-NY");
    expect(getDomicileState(pd("2024-06-30"), intervals)).toBe("US-NY");
    expect(getDomicileState(pd("2024-07-01"), intervals)).toBe("US-CA");
  });
});

// ── getStatutoryResidenceStates ─────────────────────────────────────

describe("getStatutoryResidenceStates", () => {
  const residences = [
    { year: 2024, state: "US-NY" },
    { year: 2025, state: "US-NY" },
    { year: 2025, state: "US-CA" },
  ];

  it("returns matching states for a year", () => {
    expect(getStatutoryResidenceStates(2024, residences)).toEqual(["US-NY"]);
    expect(getStatutoryResidenceStates(2025, residences).sort()).toEqual(["US-CA", "US-NY"]);
  });

  it("returns empty for a year with no statutory residence", () => {
    expect(getStatutoryResidenceStates(2023, residences)).toEqual([]);
  });
});

// ── resolveClaimingStates ───────────────────────────────────────────

describe("resolveClaimingStates", () => {
  it("returns domicile + statutory + physical location for a taxing state", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
      reportingEvents: [{ year: 2024, state: "US-NJ" }],
      yearlyDayCounts: new Map([[2024, { "US-NJ": 10 }]]),
    });
    const result = resolveClaimingStates(pd("2024-03-15"), "US-NJ", config);
    expect(result.sort()).toEqual(["US-CA", "US-NJ", "US-NY"]);
  });

  it("excludes physical location for no-income-tax state", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
      yearlyDayCounts: new Map([[2024, { "US-TX": 20 }]]),
    });
    const result = resolveClaimingStates(pd("2024-06-01"), "US-TX", config);
    expect(result.sort()).toEqual(["US-CA", "US-NY"]);
  });

  it("suppresses de minimis state when single residence state claims income", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      yearlyDayCounts: new Map([[2024, { "US-NJ": 2 }]]),
    });
    const result = resolveClaimingStates(pd("2024-03-15"), "US-NJ", config);
    // Only 1 residence state (CA) → de minimis suppressed
    expect(result).toEqual(["US-CA"]);
  });

  it("keeps de minimis state when multiple residence states claim income", () => {
    // Domiciled in CA + statutory resident of NY → 2 residence states.
    // De minimis NJ should NOT be suppressed — filing there provides
    // a credit opportunity to offset the CA/NY double taxation.
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
      yearlyDayCounts: new Map([[2024, { "US-NJ": 2 }]]),
    });
    const result = resolveClaimingStates(pd("2024-03-15"), "US-NJ", config);
    expect(result.sort()).toEqual(["US-CA", "US-NJ", "US-NY"]);
  });

  it("always suppresses no-income-tax state even with multiple residence states", () => {
    // TX has no income tax → always suppressed, regardless of residence count.
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
      yearlyDayCounts: new Map([[2024, { "US-TX": 20 }]]),
    });
    const result = resolveClaimingStates(pd("2024-06-01"), "US-TX", config);
    expect(result.sort()).toEqual(["US-CA", "US-NY"]);
  });

  it("deduplicates when domicile and physical location are the same state", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-NY" }],
      yearlyDayCounts: new Map([[2024, { "US-NY": 200 }]]),
    });
    const result = resolveClaimingStates(pd("2024-03-15"), "US-NY", config);
    expect(result).toEqual(["US-NY"]);
  });

  it("handles uncovered day (no physical location)", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
    });
    const result = resolveClaimingStates(pd("2024-03-15"), undefined, config);
    expect(result.sort()).toEqual(["US-CA", "US-NY"]);
  });

  it("returns empty when no domicile, no statutory, and location is no-income-tax", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-TX": 100 }]]),
    });
    const result = resolveClaimingStates(pd("2024-03-15"), "US-TX", config);
    expect(result).toEqual([]);
  });

  it("suppresses de minimis state when zero residence states (no domicile/statutory)", () => {
    // No residence data at all → 0 residence states ≤ 1, so suppress.
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-NJ": 2 }]]),
    });
    const result = resolveClaimingStates(pd("2024-03-15"), "US-NJ", config);
    expect(result).toEqual([]);
  });
});

// ── Integration: countWorkingDaysByLocation with state rules ────────

describe("countWorkingDaysByLocation with state rules", () => {
  it("redirects no-income-tax state days to domicile + statutory residence", () => {
    // Domiciled in CA, statutory resident of NY, working in TX (no income tax)
    const config = buildStateRulesConfig(
      [{ start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-TX" }],
      [],
      [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      [{ year: 2024, state: "US-NY" }],
      [],
    );

    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      [{ start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-TX" }],
      [],
      config,
    );

    expect(result.totalWorkingDays).toBe(5);
    // TX is suppressed (no income tax); days appear in both CA and NY
    expect(result.daysByLocation["US-CA"]).toBe(5);
    expect(result.daysByLocation["US-NY"]).toBe(5);
    expect(result.daysByLocation["US-TX"]).toBeUndefined();
  });

  it("suppresses de minimis state with single residence → domicile only", () => {
    // 3 days in NJ, domiciled in NY. No reporting event for NJ. Only 1 residence state.
    const workIntervals = [
      { start: pd("2024-01-01"), end: pd("2024-01-03"), location: "US-NJ" }, // Mon-Wed = 3
      { start: pd("2024-01-04"), end: pd("2024-01-31"), location: "US-NY" },
    ];
    const config = buildStateRulesConfig(
      workIntervals,
      [],
      [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-NY" }],
      [],
      [], // no reporting events
    );

    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-31"),
      workIntervals,
      [],
      config,
    );

    // NJ has 3 days < 5, no reporting event, single residence → suppressed
    expect(result.daysByLocation["US-NJ"]).toBeUndefined();
    expect(result.daysByLocation["US-NY"]).toBe(23); // all 23 weekdays in Jan
  });

  it("keeps de minimis state with multiple residence states for credit opportunity", () => {
    // 3 days in NJ. Domiciled in CA + statutory resident of NY → 2 residence states.
    // NJ should NOT be suppressed.
    const workIntervals = [
      { start: pd("2024-01-01"), end: pd("2024-01-03"), location: "US-NJ" }, // Mon-Wed = 3
      { start: pd("2024-01-04"), end: pd("2024-01-05"), location: "US-NY" }, // Thu-Fri = 2
    ];
    const config = buildStateRulesConfig(
      workIntervals,
      [],
      [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      [{ year: 2024, state: "US-NY" }],
      [], // no reporting events — NJ is de minimis candidate
    );

    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      workIntervals,
      [],
      config,
    );

    expect(result.totalWorkingDays).toBe(5);
    // NJ kept (de minimis not suppressed with 2 residence states)
    expect(result.daysByLocation["US-NJ"]).toBe(3);
    // CA gets all 5 (domicile)
    expect(result.daysByLocation["US-CA"]).toBe(5);
    // NY gets all 5 (statutory + 2 physical)
    expect(result.daysByLocation["US-NY"]).toBe(5);
  });

  it("does NOT suppress de minimis state when reporting event exists", () => {
    const workIntervals = [
      { start: pd("2024-01-01"), end: pd("2024-01-03"), location: "US-NJ" }, // 3 days
      { start: pd("2024-01-04"), end: pd("2024-01-31"), location: "US-NY" },
    ];
    const config = buildStateRulesConfig(
      workIntervals,
      [],
      [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-NY" }],
      [],
      [{ year: 2024, state: "US-NJ" }], // NJ reporting event
    );

    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-31"),
      workIntervals,
      [],
      config,
    );

    // NJ has reporting event → NOT suppressed (not de minimis)
    expect(result.daysByLocation["US-NJ"]).toBe(3);
    expect(result.daysByLocation["US-NY"]).toBe(23); // 20 physical + 3 domicile
  });

  it("does NOT suppress when >=5 days even without reporting event", () => {
    const workIntervals = [
      { start: pd("2024-01-01"), end: pd("2024-01-07"), location: "US-NJ" }, // Mon-Fri = 5
      { start: pd("2024-01-08"), end: pd("2024-01-31"), location: "US-NY" },
    ];
    const config = buildStateRulesConfig(
      workIntervals,
      [],
      [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-NY" }],
      [],
      [],
    );

    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-31"),
      workIntervals,
      [],
      config,
    );

    // NJ has 5 days (>=5) → NOT suppressed
    expect(result.daysByLocation["US-NJ"]).toBe(5);
    // NY: 18 physical + 5 domicile-on-NJ-days = 23
    expect(result.daysByLocation["US-NY"]).toBe(23);
  });

  it("multi-state: domicile CA + statutory NY + work in NJ → three claims", () => {
    const workIntervals = [{ start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NJ" }];
    const config = buildStateRulesConfig(
      workIntervals,
      [],
      [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      [{ year: 2024, state: "US-NY" }],
      [{ year: 2024, state: "US-NJ" }], // reporting event prevents de minimis
    );

    const result = countWorkingDaysByLocation(
      pd("2024-01-01"),
      pd("2024-01-05"),
      workIntervals,
      [],
      config,
    );

    expect(result.totalWorkingDays).toBe(5);
    expect(result.daysByLocation["US-CA"]).toBe(5); // domicile
    expect(result.daysByLocation["US-NY"]).toBe(5); // statutory residence
    expect(result.daysByLocation["US-NJ"]).toBe(5); // physical (non-resident)
  });

  it("uncovered days go to domicile + statutory residence", () => {
    const config = buildStateRulesConfig(
      [], // no work intervals at all
      [],
      [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      [{ year: 2024, state: "US-NY" }],
      [],
    );

    const result = countWorkingDaysByLocation(pd("2024-01-01"), pd("2024-01-05"), [], [], config);

    expect(result.totalWorkingDays).toBe(5);
    expect(result.daysByLocation["US-CA"]).toBe(5);
    expect(result.daysByLocation["US-NY"]).toBe(5);
  });
});

// ── Integration: engine with state rules ────────────────────────────

describe("computeAllocations with state rules", () => {
  it("legacy behaviour: no domicile/statutory → unchanged", () => {
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-07-01"), shares: 100, fmvPerShare: 50 }],
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NY" }],
    };

    const result = computeAllocations(input);
    expect(result[0].vestAllocations[0].fractionByLocation["US-NY"]).toBeCloseTo(1.0);
  });

  it("no-income-tax state work redirects to domicile for RSU vest", () => {
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-01-12"), shares: 100, fmvPerShare: 50 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-TX" }, // 5 days TX
        { start: pd("2024-01-08"), end: pd("2024-01-12"), location: "US-NY" }, // 5 days NY
      ],
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-NY" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    // TX days suppressed → redirected to NY domicile. All 10 days → NY.
    expect(alloc.daysByLocation["US-NY"]).toBe(10);
    expect(alloc.daysByLocation["US-TX"]).toBeUndefined();
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(1.0);
  });

  it("fractions sum to >1 when domicile and statutory residence differ", () => {
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-01-05"), shares: 100, fmvPerShare: 10 }],
        },
      ],
      // Work physically in NY all week
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-01-05"), location: "US-NY" }],
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    // NY: 5 (physical + statutory) = 5, CA: 5 (domicile) = 5
    expect(alloc.daysByLocation["US-NY"]).toBe(5);
    expect(alloc.daysByLocation["US-CA"]).toBe(5);
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(1.0);
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(1.0);
  });

  it("de minimis kept with multi-residence for RSU vest", () => {
    // Domiciled in CA, statutory resident of NY.
    // 3 days in NJ (de minimis candidate), 5 days in NY.
    // Because 2 residence states, NJ is NOT suppressed → credit opportunity.
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-01-12"), shares: 100, fmvPerShare: 10 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-01-03"), location: "US-NJ" }, // 3 days
        { start: pd("2024-01-04"), end: pd("2024-01-12"), location: "US-NY" }, // 7 days
      ],
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];
    expect(alloc.totalDays).toBe(10);
    expect(alloc.daysByLocation["US-NJ"]).toBe(3); // kept for credit
    expect(alloc.daysByLocation["US-CA"]).toBe(10); // domicile: all days
    expect(alloc.daysByLocation["US-NY"]).toBe(10); // statutory + physical
  });
});

describe("computeSalaryAllocations with state rules", () => {
  it("de minimis suppression works for salary allocation with single residence", () => {
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-01-03"), location: "US-NJ" }, // 3 days
        { start: pd("2024-01-04"), end: pd("2024-12-31"), location: "US-NY" },
      ],
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-NY" }],
    };

    const result = computeSalaryAllocations(input);
    expect(result).toHaveLength(1);
    // NJ had 3 days, no reporting event, single residence → suppressed
    expect(result[0].daysByLocation["US-NJ"]).toBeUndefined();
    expect(result[0].daysByLocation["US-NY"]).toBe(262);
  });

  it("de minimis NOT suppressed for salary with multi-residence", () => {
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-01-03"), location: "US-NJ" }, // 3 days
        { start: pd("2024-01-04"), end: pd("2024-12-31"), location: "US-NY" },
      ],
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
    };

    const result = computeSalaryAllocations(input);
    expect(result).toHaveLength(1);
    // NJ kept (2 residence states → credit opportunity)
    expect(result[0].daysByLocation["US-NJ"]).toBe(3);
    expect(result[0].daysByLocation["US-CA"]).toBe(262); // domicile: all days
    expect(result[0].daysByLocation["US-NY"]).toBe(262); // statutory + physical
  });
});
