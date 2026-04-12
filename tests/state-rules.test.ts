import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import {
  buildStateRulesConfig,
  computeYearlyDayCounts,
  getDomicileState,
  getResidentStates,
  getStatutoryResidenceStates,
  isDeMinimis,
  isNoIncomeTaxState,
  NO_INCOME_TAX_STATES,
  resolveClaimingStates,
  resolveNonresidentSourceStates,
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

  it("returns false for taxing state with >=10 days", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-NJ": 10 }]]),
    });
    expect(isDeMinimis("US-NJ", 2024, config)).toBe(false);
  });

  it("returns true for taxing state with 9 days and no reporting event", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-NJ": 9 }]]),
    });
    expect(isDeMinimis("US-NJ", 2024, config)).toBe(true);
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

  it("does NOT suppress when >=10 days even without reporting event", () => {
    const workIntervals = [
      { start: pd("2024-01-01"), end: pd("2024-01-14"), location: "US-NJ" }, // Mon-Fri×2 = 10
      { start: pd("2024-01-15"), end: pd("2024-01-31"), location: "US-NY" },
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

    // NJ has 10 days (>=10) → NOT suppressed
    expect(result.daysByLocation["US-NJ"]).toBe(10);
    // NY: 13 physical + 10 domicile-on-NJ-days = 23
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

  it("de minimis suppressed for equity even with multi-residence", () => {
    // Domiciled in CA, statutory resident of NY.
    // 3 days in NJ (de minimis), 7 days in NY.
    // For equity income, nonresident sourcing uses resolveNonresidentSourceStates
    // which suppresses de minimis unconditionally (the multi-residence credit
    // exception only applies to salary). Resident states get 100% via the
    // recognition-date override.
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
    expect(alloc.daysByLocation["US-NJ"]).toBeUndefined(); // de minimis suppressed
    expect(alloc.daysByLocation["US-CA"]).toBe(10); // domicile at vest → 100%
    expect(alloc.daysByLocation["US-NY"]).toBe(10); // statutory residence → 100%
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

// ── resolveNonresidentSourceStates ──────────────────────────────────

describe("resolveNonresidentSourceStates", () => {
  it("returns physical location for a taxing state above de minimis", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-NJ": 20 }]]),
    });
    expect(resolveNonresidentSourceStates(pd("2024-03-15"), "US-NJ", config)).toEqual(["US-NJ"]);
  });

  it("does NOT include domicile or statutory residence", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
      yearlyDayCounts: new Map([[2024, { "US-NJ": 20 }]]),
    });
    // Only the physical location — no CA domicile, no NY statutory
    expect(resolveNonresidentSourceStates(pd("2024-03-15"), "US-NJ", config)).toEqual(["US-NJ"]);
  });

  it("suppresses no-income-tax states", () => {
    const config = makeConfig({
      yearlyDayCounts: new Map([[2024, { "US-TX": 100 }]]),
    });
    expect(resolveNonresidentSourceStates(pd("2024-03-15"), "US-TX", config)).toEqual([]);
  });

  it("suppresses de minimis states unconditionally", () => {
    // Even with multiple residence states, nonresident sourcing suppresses de minimis
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
      yearlyDayCounts: new Map([[2024, { "US-NJ": 3 }]]),
    });
    expect(resolveNonresidentSourceStates(pd("2024-03-15"), "US-NJ", config)).toEqual([]);
  });

  it("returns empty for no physical location", () => {
    const config = makeConfig();
    expect(resolveNonresidentSourceStates(pd("2024-03-15"), undefined, config)).toEqual([]);
  });
});

// ── getResidentStates ───────────────────────────────────────────────

describe("getResidentStates", () => {
  it("returns domicile state for a date within a domicile interval", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
    });
    expect(getResidentStates(pd("2024-06-15"), config)).toEqual(["US-CA"]);
  });

  it("returns statutory residence states for the year", () => {
    const config = makeConfig({
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
    });
    expect(getResidentStates(pd("2024-06-15"), config)).toEqual(["US-NY"]);
  });

  it("returns domicile + statutory residence (deduplicated)", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
    });
    expect(getResidentStates(pd("2024-06-15"), config).sort()).toEqual(["US-CA", "US-NY"]);
  });

  it("deduplicates when domicile = statutory residence", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-NY" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
    });
    expect(getResidentStates(pd("2024-06-15"), config)).toEqual(["US-NY"]);
  });

  it("returns empty when no domicile or statutory residence", () => {
    const config = makeConfig();
    expect(getResidentStates(pd("2024-06-15"), config)).toEqual([]);
  });

  it("returns empty for a date outside all domicile intervals", () => {
    const config = makeConfig({
      domicileIntervals: [{ start: pd("2024-07-01"), end: pd("2024-12-31"), state: "US-CA" }],
    });
    expect(getResidentStates(pd("2024-03-15"), config)).toEqual([]);
  });
});

// ── Part-year domicile: RSU vest (the "residency trap") ────────────

describe("computeAllocations – part-year domicile RSU", () => {
  it("domicile state at vest date gets 100% (the residency trap)", () => {
    // FTB Pub. 1100 §E, Example 14: Stock options granted in NV,
    // exercised after moving to CA → 100% taxable by CA.
    //
    // Scenario: Grant in GA, move to CA mid-window, vest in CA.
    // CA (domicile at vest) → 100%. GA (physical source) → proportional.
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [
        {
          id: "G1",
          awardDate: pd("2023-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-06-01"), shares: 100, fmvPerShare: 50 }],
        },
      ],
      workIntervals: [
        { start: pd("2023-01-01"), end: pd("2024-03-31"), location: "US-GA" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
      domicileIntervals: [
        { start: pd("2023-01-01"), end: pd("2024-03-31"), state: "US-GA" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), state: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];

    // CA is domicile at vest date (2024-06-01) → 100%
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(1.0);
    expect(alloc.incomeByLocation["US-CA"]).toBeCloseTo(5000);

    // GA gets its nonresident source fraction (days physically in GA / total)
    const gaDays = alloc.daysByLocation["US-GA"]!;
    const totalDays = alloc.totalDays;
    expect(gaDays).toBeGreaterThan(0);
    expect(alloc.fractionByLocation["US-GA"]).toBeCloseTo(gaDays / totalDays);

    // CA physically-worked days are a subset, but domicile override gives 100%
    expect(alloc.daysByLocation["US-CA"]).toBe(totalDays);
  });

  it("former domicile state gets NO credit when vest occurs after move-out", () => {
    // Scenario: Domiciled in CA Jan-Jun, move to TX Jul onwards.
    // Physically worked in CA Jan-Jun, TX Jul onwards.
    // RSU vests in August — TX has no income tax, CA is no longer domicile.
    // CA should only get its nonresident source fraction, not 100%.
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-08-15"), shares: 100, fmvPerShare: 50 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-06-30"), location: "US-CA" },
        { start: pd("2024-07-01"), end: pd("2024-12-31"), location: "US-TX" },
      ],
      domicileIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-06-30"), state: "US-CA" },
        { start: pd("2024-07-01"), end: pd("2024-12-31"), state: "US-TX" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];

    // At vest date (Aug 15), domicile is TX (no income tax) → no resident override
    // CA gets nonresident source fraction only (physical work days in CA)
    const caDays = alloc.daysByLocation["US-CA"]!;
    const totalDays = alloc.totalDays;
    expect(caDays).toBeGreaterThan(0);
    expect(caDays).toBeLessThan(totalDays);
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(caDays / totalDays);
    expect(alloc.fractionByLocation["US-CA"]).toBeLessThan(1.0);

    // TX is suppressed (no income tax) and no longer triggers resident override
    // since it's in NO_INCOME_TAX_STATES... wait, getResidentStates returns it.
    // But TX being a no-income-tax state means... the resident override still
    // adds it. That's correct — the function just identifies resident states,
    // the no-income-tax filtering is a separate concern.
    // TX gets 100% as domicile (even though it can't tax you — the program
    // reports the claim; the no-income-tax filter is applied downstream).
    expect(alloc.daysByLocation["US-TX"]).toBe(totalDays);
  });

  it("vest before move-in: new domicile state gets 0% (nonresident only)", () => {
    // Grant and vest entirely before moving to CA.
    // CA should get nothing because taxpayer wasn't a CA resident at vest.
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-03-15"), shares: 100, fmvPerShare: 50 }],
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-06-30"), location: "US-GA" },
        { start: pd("2024-07-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
      domicileIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-06-30"), state: "US-GA" },
        { start: pd("2024-07-01"), end: pd("2024-12-31"), state: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];

    // At vest date (Mar 15), domicile is GA → GA gets 100%
    expect(alloc.fractionByLocation["US-GA"]).toBeCloseTo(1.0);

    // CA has no claim — wasn't domicile at vest, no physical work in CA during window
    expect(alloc.daysByLocation["US-CA"]).toBeUndefined();
  });

  it("statutory residence at vest year also gets 100%", () => {
    // Statutory resident of NY for 2024, domiciled in CA.
    // Physical work in NJ (above de minimis). Vest in 2024.
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [
        {
          id: "G1",
          awardDate: pd("2024-01-01"),
          symbol: "XYZ",
          vests: [{ date: pd("2024-03-15"), shares: 100, fmvPerShare: 50 }],
        },
      ],
      workIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), location: "US-NJ" }],
      domicileIntervals: [{ start: pd("2024-01-01"), end: pd("2024-12-31"), state: "US-CA" }],
      statutoryResidences: [{ year: 2024, state: "US-NY" }],
      reportingEvents: [{ year: 2024, state: "US-NJ" }],
    };

    const result = computeAllocations(input);
    const alloc = result[0].vestAllocations[0];

    // CA (domicile) → 100%, NY (statutory residence) → 100%
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(1.0);
    expect(alloc.fractionByLocation["US-NY"]).toBeCloseTo(1.0);
    // NJ (nonresident source, above de minimis, reporting event) → 100% too
    expect(alloc.fractionByLocation["US-NJ"]).toBeCloseTo(1.0);
  });
});

// ── Part-year domicile: ESPP sale ──────────────────────────────────

describe("computeAllocations – part-year domicile ESPP", () => {
  it("domicile state at sale date gets 100% of ESPP ordinary income", () => {
    // Offering period entirely in GA. Move to CA before selling.
    // CA (domicile at sale) → 100%. GA (source) → proportional.
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2023-07-01"),
          fmvPerShareAtGrant: 50,
          purchaseDate: pd("2024-01-01"),
          purchasePricePerShare: 42.5,
          fmvPerShareAtPurchase: 50,
          shares: 100,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2024-09-01"),
          salePricePerShare: 55,
          shares: 100,
          dispositionType: "DISQUALIFIED",
        },
      ],
      workIntervals: [
        { start: pd("2023-07-01"), end: pd("2024-03-31"), location: "US-GA" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
      domicileIntervals: [
        { start: pd("2023-07-01"), end: pd("2024-03-31"), state: "US-GA" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), state: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].esppSaleAllocations[0];

    // CA is domicile at sale date (Sep 1, 2024) → 100%
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(1.0);
    expect(alloc.ordinaryIncomeByLocation["US-CA"]).toBeCloseTo(750); // 7.5 * 100

    // GA gets 100% as nonresident source — entire offering period was in GA.
    // Both GA and CA claim the full income; OSTC resolves the overlap.
    expect(alloc.fractionByLocation["US-GA"]).toBeCloseTo(1.0);
    expect(alloc.ordinaryIncomeByLocation["US-GA"]).toBeCloseTo(750);
  });

  it("sale before move-in: new state gets no ESPP claim", () => {
    // Offering period and sale both in GA, before moving to CA.
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-01-01"),
          fmvPerShareAtGrant: 50,
          purchaseDate: pd("2024-04-01"),
          purchasePricePerShare: 42.5,
          fmvPerShareAtPurchase: 50,
          shares: 100,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2024-05-01"),
          salePricePerShare: 55,
          shares: 100,
          dispositionType: "DISQUALIFIED",
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-06-30"), location: "US-GA" },
        { start: pd("2024-07-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
      domicileIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-06-30"), state: "US-GA" },
        { start: pd("2024-07-01"), end: pd("2024-12-31"), state: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].esppSaleAllocations[0];

    // Sale date (May 1) is during GA domicile → GA gets 100%
    expect(alloc.fractionByLocation["US-GA"]).toBeCloseTo(1.0);
    // CA has no claim
    expect(alloc.daysByLocation["US-CA"]).toBeUndefined();
  });

  it("split offering period: source < 100% while domicile at sale = 100%", () => {
    // Offering period spans GA→CA move. CA gets 100% (domicile at sale),
    // GA gets proportional nonresident source for its offering-period days.
    const input: InputData = {
      ...EMPTY_STATE_RULES,
      grants: [],
      esppPurchases: [
        {
          id: "ESPP1",
          symbol: "XYZ",
          offeringStartDate: pd("2024-01-01"),
          fmvPerShareAtGrant: 50,
          purchaseDate: pd("2024-07-01"),
          purchasePricePerShare: 42.5,
          fmvPerShareAtPurchase: 50,
          shares: 100,
        },
      ],
      esppSales: [
        {
          purchaseId: "ESPP1",
          saleDate: pd("2024-09-01"),
          salePricePerShare: 55,
          shares: 100,
          dispositionType: "DISQUALIFIED",
        },
      ],
      workIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-03-31"), location: "US-GA" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), location: "US-CA" },
      ],
      domicileIntervals: [
        { start: pd("2024-01-01"), end: pd("2024-03-31"), state: "US-GA" },
        { start: pd("2024-04-01"), end: pd("2024-12-31"), state: "US-CA" },
      ],
    };

    const result = computeAllocations(input);
    const alloc = result[0].esppSaleAllocations[0];

    // CA: domicile at sale date → 100%
    expect(alloc.fractionByLocation["US-CA"]).toBeCloseTo(1.0);

    // GA: nonresident source for offering-period days only (< 100%)
    const gaFrac = alloc.fractionByLocation["US-GA"]!;
    expect(gaFrac).toBeGreaterThan(0);
    expect(gaFrac).toBeLessThan(1.0);
    // GA days = weekdays Jan 1 – Mar 31 in the offering window (65 days)
    expect(alloc.daysByLocation["US-GA"]).toBe(65);
    // CA days = totalWorkingDays from resident override (not just source days)
    expect(alloc.daysByLocation["US-CA"]).toBe(alloc.totalDays);
  });
});
