# other-state-tax-credit

Apportions income and prorates equity compensation to enable calculating **Other-State Tax Credits**.

## Background

When you work in multiple US states, each state may independently claim the
right to tax your equity compensation. Filing requires knowing, for each
state, how much income it can tax and in what capacity — resident (worldwide
income) or nonresident (sourced income only). Part-year residents must split
income between the portion of the year they were resident and the portion they
were not. Where two states tax the same dollar, the overlap is resolved
through other-state tax credits (OSTCs), which require the dollar amount of
income sourced to each nonresident state.

Due to state statutes and regulations, Box 16 ("State wages, tips, etc.") of
Form W-2 often contains an **overestimate** of state tax liability. This
program intends to compute corrected figures. It takes your RSU vesting
schedules, ESPP purchase/sale records, work-location history, and domicile
timeline, then produces per-state income split by filing status (resident vs.
nonresident) along with the cross-state amounts needed for OSTC worksheets.

Salary and other non-equity W-2 compensation is prorated by working-day
fraction over each calendar year. RSU income is allocated over the grant-to-vest
window, and ESPP ordinary income over the offering period (offering start
through purchase date), per
[20 NYCRR Section 132.18(a)](https://www.law.cornell.edu/regulations/new-york/20-NYCRR-132.18),
[TSB-M07(7)I](https://www.tax.ny.gov/pdf/memos/income/m07_7i.pdf), and
[Instructions for Form IT-203-F](https://www.tax.ny.gov/pdf/current_forms/it/it203fi.pdf).

### Multi-state claiming

Each working day's income is claimed by the **union** of your **domicile
state** on that date, any **statutory residence** states for that year, and the
**physical work location** (non-resident sourcing) — unless that location is
suppressed. State taxable income may therefore sum to more than 100% of federal amount when multiple
states independently claim the same income.

### Resident vs. nonresident classification

For each claiming state, the program classifies the income as either
**resident** (the taxpayer was domiciled there or had statutory residence at
the income recognition date) or **nonresident** (the state's claim arises
solely from the physical work location). A single state can appear in both
categories within the same tax year if residency changes mid-year — for
example, an RSU vesting while domiciled in NY produces resident NY income,
while a later vest after moving to CA produces nonresident NY source income.

The OSTC section cross-references every (resident state, nonresident state)
pair and reports the income amounts: "while resident of CA, $X of RSU income
was sourced to NY." These are the figures that go on the resident state's
OSTC worksheet.

### Suppression rules

A physical work location is suppressed (excluded from the claiming states) when:

1. **No-income-tax state** — The state does not levy a personal income tax on
   earned income (AK, FL, NV, NH, SD, TN, TX, WA, WY). Always suppressed;
   you cannot file there regardless.

2. **De minimis exception** — Fewer than 10 work days in the state for the
   year AND no **new** reporting event (W-2/1099) was filed for that state.
   Suppressed only when **one or fewer** residence states claim the income.
   When multiple residence states claim it, the de minimis state is kept so
   the taxpayer can file there and obtain credits to offset the otherwise
   unrelieved double taxation between residence states.

## Limitations

- You must encode New York's legal sourcing rules into `work-location.csv` yourself.
  In particular, remote days worked outside New York for your own convenience
  may still need to be entered as `US-NY` under the convenience-of-the-employer rule.
- Normal work days spent at home may need to be entered as `US-NY` if your assigned office is in New York.
- Weekend work (for example, Sunday travel or Saturday meetings) is not yet modeled; weekends are always excluded.
- Schwab import: the CSV export is missing data; use API JSON instead.

## Usage

1. Create and enter a data directory, e.g. `my-data/`
1. Sign in to Schwab
1. Navigate to Accounts > Equity Awards > [View Equity Details](https://client.schwab.com/app/accounts/equityawards/#/equityTodayView)
1. Download Awards.json from https://ausgateway.schwab.com/api/is.EacDashboardWeb/v1/Awards?Type=All&EsppData=True&AllowFullDetails=true&IsHistoricalAwards=true&PendingTransactions=true
1. Navigate to Accounts > [Transaction History](https://client.schwab.com/app/accounts/history/#/) > Equity Award Center > Last 4 years > Export > JSON and save
1. Populate `work-location.csv` containing a sequence of interval-to-location pairs:

   ```csv
   interval,location
   2024-08-01/2024-12-15,US-NY
   ```

   - `interval` is an [ISO 8601 Time Interval](https://en.wikipedia.org/wiki/ISO_8601#Time_intervals) (closed interval)
   - `location` is an [ISO 3166-2](https://en.wikipedia.org/wiki/ISO_3166-2:US) subdivision

1. Populate `domicile.csv` with your state of domicile over time:

   ```csv
   interval,state
   2024-01-01/2024-06-30,US-NY
   2024-07-01/2024-12-31,US-CA
   ```

   - `interval` is a closed date interval (or a single date)
   - `state` is an ISO 3166-2 subdivision
   - Everyone is domiciled somewhere; this file is required

1. Optionally populate `statutory-residence.csv` if you triggered statutory
   residence in a state (e.g. 183-day + permanent place of abode rule):

   ```csv
   year,state
   2025,US-NY
   ```

1. Optionally populate `reporting-events.csv` to record which states had
   income reported on a W-2 or 1099 each year. This prevents the de minimis
   exception from suppressing those states:

   ```csv
   year,state
   2024,US-NY
   2024,US-CA
   ```

1. Optionally populate `holidays.csv` to exclude non-working weekdays from both the numerator and denominator:

   ```csv
   interval,category
   2025-01-01,holiday
   2025-02-14,vacation
   2025-07-03/2025-07-04,holiday
   ```

   - `interval` may be either a single date (for one day off) or a closed date interval
   - `category` is a free-form label such as `holiday`, `vacation`, `sick`, or `leave`
   - Weekends are always excluded automatically; `holidays.csv` is for non-working weekdays

1. Any working weekday not covered by `work-location.csv` is treated as
   uncovered — it still counts in the denominator but is not attributed to
   any physical work state (to enable lightweight usage to figure income _not_ sourced to your sole domiciled state). Overlapping work-location intervals are errors.

1. `npm run dev -- /path/to/data/`
