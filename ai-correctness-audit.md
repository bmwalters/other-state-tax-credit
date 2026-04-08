# README sources regulatory audit

**Session ID:** ses_293eebf2fffelpBalyXdUAZBQA
**Created:** 4/8/2026, 7:49:23 AM
**Updated:** 4/8/2026, 7:51:35 AM

---

## User

Hi! Can you download the sources linked from readme then audit if the program is correct as per the legal and regulatory requirements? Let me know if you have any clarifying questions. Thank you!

---

## Assistant



I'll start by reading the README to understand the project and find the linked sources.

**Tool: read**

**Tool: read**

---

## Assistant

Let me explore the project structure and read all source files, plus download the linked regulatory documents.

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: webfetch**

**Tool: webfetch**

**Tool: webfetch**

---

## Assistant

Good - I've fetched the regulatory sources. The two PDFs came back as raw binary (they're not text-extractable via web fetch), but I successfully retrieved the full text of **20 NYCRR § 132.18**. Now let me read all the source code files to understand the implementation.

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant

---

## User

Let's also download the PDFs locally and use npx to extract text.

---

## Assistant



Good idea! Let me download the PDFs and extract their text.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

`pdftotext` is available. Let me use it directly:

**Tool: bash**

---

## Assistant

**Tool: read**

**Tool: read**

---

## Assistant

Now let me also read the remaining source files to complete my understanding of the codebase:

**Tool: glob**

**Tool: glob**

---

## Assistant

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant

Now let me also run the existing tests to confirm the current state:

**Tool: bash**

---

## Assistant

All 24 tests pass. Now I have a complete picture of the codebase and the regulatory sources. Let me produce the audit.

---

# Audit: NY RSU Income Calculator vs. Legal & Regulatory Requirements

I've reviewed the program's source code against the three authoritative sources:

1. **20 NYCRR § 132.18** — NYS regulation on earnings allocation for nonresident employees
2. **TSB-M-07(7)I** — NYS Tax Department memo on stock options, restricted stock, and SARs for nonresidents/part-year residents
3. **IT-203-F Instructions** — Instructions for the Multi-Year Allocation Form (Schedule B)

## What the program does correctly ✅

### 1. Grant-to-vest allocation period
The program uses `grant.awardDate` → `vest.date` as the allocation period (engine.ts:37–38). This is **correct** per TSB-M-07(7)I which states:

> *"The allocation period for [restricted stock where no §83(b) election is made] is the period of time beginning with the date the stock was received and ending with the earliest of: (1) the date the stock was substantially vested..."*

For RSUs (which is what this program handles via Schwab), "date received" = grant date and "substantially vested" = vest date. ✅

### 2. Per-tranche allocation
The program computes a separate NY fraction for each individual vest event on each grant (engine.ts:66–72). This is **correct** — each vest has its own allocation period (grant date → that specific vest date), and different vests of the same grant can have different NY fractions. ✅

### 3. Income = shares × FMV at vest
The program computes `income = vest.shares * vest.fmvPerShare` (engine.ts:42). This is **correct** per TSB-M-07(7)I and IRC §83 — for restricted stock with no §83(b) election, compensation = FMV at vesting minus amount paid. Since RSU grants have zero purchase price, this simplifies to FMV × shares. ✅

### 4. Grouping by tax year
Vests are grouped by the year of the vest date (engine.ts:69). Income is recognized in the year of vesting. ✅

### 5. Proportional workday allocation formula
The NY fraction = (days in NY during allocation period) / (total days in allocation period), applied to compensation. This matches the core formula from §132.18(a) and TSB-M-07(7)I. ✅

---

## Issues found 🔴🟡

### 🔴 Issue 1: Uses calendar days instead of working days (MATERIAL)

**The regulation requires working days, not calendar days.**

§132.18(a) is unambiguous:
> *"that proportion of his total compensation...which the **total number of working days** employed within New York State bears to the **total number of working days** employed both within and without New York State"*

> *"no account is taken of nonworking days, including Saturdays, Sundays, holidays, days of absence because of illness or personal injury, vacation, or leave with or without pay."*

The IT-203-F form (Schedule B, lines 6–13) has an explicit worksheet to subtract Saturdays/Sundays, holidays, sick days, and vacation from total calendar days to arrive at working days.

**What the program does:** The engine comment on line 13–14 acknowledges this: *"We approximate with calendar days rather than actual business days."* The denominator `totalDays` (line 38) is simply `grant.awardDate.until(vest.date).total("day")` — raw calendar days. The numerator also uses calendar days of overlap with work intervals.

**Impact:** This approximation **overstates the denominator** (calendar days > working days) when the user has declared fewer work-location intervals than the full period. Conversely, if the user declares contiguous intervals covering the full period, it may still produce an incorrect ratio because weekends/holidays are counted in both numerator and denominator. The direction and magnitude of the error depends on the specific facts, but it is a **deviation from the legally prescribed formula**.

The README acknowledges this as a limitation ("Assumes proportionality of workdays across NY days and non-NY days"), but this should be clearly flagged in program output as well.

### 🟡 Issue 2: `countDaysByLocation` uses a half-open interval that may exclude the vest date (MODERATE)

**engine.ts:27:**
```typescript
const days = overlapStart.until(overlapEnd).total("day");
```

`Temporal.PlainDate.until()` computes a half-open interval `[start, end)` — it counts the number of days from start up to but **not including** end. This means:
- The **vest date itself is excluded** from the count (since `end` = `vest.date` and `.until()` is exclusive of end).
- The **grant date is included** in the count.

Per §132.18 and TSB-M-07(7)I, the allocation period runs from grant date to vest date. The regulation doesn't explicitly state whether the endpoints are inclusive, but the IT-203-F form says "Enter the total number of days in the allocation period" (line 6) which would naturally include both endpoints. Excluding the vest date from the count means both the denominator and numerator lose one day. While this is internally consistent (both totalDays and daysByLocation use the same convention), it may produce a slightly different ratio than the official form worksheet which counts total calendar days inclusively.

### 🟡 Issue 3: No handling of the "convenience of the employer" rule (MODERATE)

§132.18(a) states:
> *"any allowance claimed for days worked outside New York State must be based upon the performance of services which **of necessity, as distinguished from convenience**, obligate the employee to out-of-state duties"*

IT-203-F line 14 reiterates:
> *"You must base any allowance for days worked outside New York State upon the performance of services which, because of necessity (not convenience) of the employer, obligate you to out-of-state duties"*

This is the famous "convenience of the employer" test — if you work from home outside NY for your own convenience (not because your employer requires it), those days count as NY days.

The program takes work-location intervals at face value with no validation or warning about this rule. A user who naively enters their physical location without considering this rule could significantly under-allocate income to NY.

### 🟡 Issue 4: Work-at-home days default (MODERATE)

IT-203-F line 15 states:
> *"Normal work days spent at home are considered days worked in New York State. Days spent working at home that are not normal work days are considered nonworking days."*

The program has no mechanism to account for this distinction. Days working from home on normal workdays should default to NY (if the office is in NY), but the program relies entirely on user-declared location intervals.

### 🟡 Issue 5: No validation that work intervals cover the full allocation period (MODERATE)

If a user provides work intervals that don't fully cover the grant-to-vest period, the uncovered days are effectively treated as "no location" — they don't appear in any numerator but they DO appear in the `totalDays` denominator (which is computed independently from calendar days). This silently under-allocates income to all locations. The sum of `fractionByLocation` values may be well under 1.0 with no warning.

### 🟡 Issue 6: No handling of overlapping work intervals

If a user provides overlapping work intervals (e.g., accidentally entering overlapping date ranges), days in the overlap would be double-counted in the numerator, potentially producing fractions > 1.0. There is no validation or deduplication.

### 🔵 Issue 7: RSU-only scope not clearly enforced (MINOR)

The program is designed for RSUs only (the Schwab importer filters for `awardType === "RSU"`), but TSB-M-07(7)I describes different allocation rules for:
- **Stock options** (statutory & nonstatutory) — grant-to-vest for most, but grant-to-exercise for some
- **Stock appreciation rights** — grant-to-vest
- **Restricted stock with §83(b) election** — uses the regular workday fraction for the year of receipt, not a multi-year allocation

The program's types and engine don't enforce RSU-only semantics — if someone manually constructed `InputData` with stock option data, the engine would apply the wrong allocation method for options that should use grant-to-exercise. This is minor since the only importer is RSU-specific.

### 🔵 Issue 8: Schwab importer uses `awardDate` for the allocation start (MINOR)

For restricted stock (RSUs), TSB-M-07(7)I says the allocation period starts on the date the stock was **received** (not necessarily the award date). For RSUs, the "date received" is typically the grant date, so `awardDate` is likely correct. However, the program should document this assumption since some RSU plans distinguish between board approval date and actual grant/receipt date.

---

## Summary

| # | Issue | Severity | Regulatory Source |
|---|-------|----------|-------------------|
| 1 | Calendar days vs. working days | 🔴 Material | §132.18(a), IT-203-F lines 6–13 |
| 2 | Half-open interval (vest date excluded) | 🟡 Moderate | IT-203-F line 6 |
| 3 | No "convenience of employer" guidance | 🟡 Moderate | §132.18(a), IT-203-F line 14 |
| 4 | Work-at-home default to NY | 🟡 Moderate | IT-203-F line 15 |
| 5 | Gaps in work intervals silently under-allocate | 🟡 Moderate | General correctness |
| 6 | Overlapping work intervals not validated | 🟡 Moderate | General correctness |
| 7 | RSU-only scope not enforced in engine | 🔵 Minor | TSB-M-07(7)I |
| 8 | `awardDate` vs. "date received" assumption | 🔵 Minor | TSB-M-07(7)I |

**The most significant finding is Issue #1:** the regulation and official form explicitly prescribe a working-days formula (excluding weekends, holidays, sick days, vacation), whereas the program uses raw calendar days. The README acknowledges this as a "limitation" but it's a fundamental deviation from the legal formula that could produce materially different results depending on the distribution of NY vs. non-NY work across weekdays vs. weekends.

---

