# Multi-State RSU/ESPP Income Calculator

## Background

When you work in multiple US states, each state may claim the right to tax
your equity compensation. This program computes how income from RSU vests and
ESPP sales is allocated across states based on where you physically worked.

For RSU vests, income is allocated using the working-day fraction over the
grant-to-vest window per
[NYS Regulation Section 132.18(a)](https://www.law.cornell.edu/regulations/new-york/20-NYCRR-132.18),
[TSB-M07(7)I](https://www.tax.ny.gov/pdf/memos/income/m07_7i.pdf), and
[Instructions for Form IT-203-F](https://www.tax.ny.gov/pdf/current_forms/it/it203fi.pdf).

For ESPP sales, ordinary income is allocated using the working-day fraction
over the offering period (offering start → purchase date).

### Multi-state taxation

Each working day's income is claimed by the **union** of:

- Your **domicile state** on that date (taxes all income earned while domiciled)
- Any **statutory residence** states for that year (tax all income for the year)
- The **physical work location** (non-resident sourcing) — unless suppressed

This means the state fractions may **sum to more than 100%** when multiple
states independently claim the same income (e.g. domicile CA + statutory
resident NY + physically working in NJ).

### Suppression rules

A physical work location is suppressed (excluded from the claiming states) when:

1. **No-income-tax state** — The state does not levy a personal income tax on
   earned income (AK, FL, NV, NH, SD, TN, TX, WA, WY). Always suppressed;
   you cannot file there regardless.

2. **De minimis exception** — Fewer than 5 work days in the state for the
   year AND no reporting event (W-2/1099) was filed for that state.
   Suppressed only when **one or fewer** residence states claim the income.
   When multiple residence states claim it, the de minimis state is kept so
   the taxpayer can file there and obtain credits to offset the otherwise
   unrelieved double taxation between residence states.

## Limitations

- You must encode New York's legal sourcing rules into `work-location.csv` yourself.
  In particular, remote days worked outside New York for your own convenience
  may still need to be entered as `US-NY` under the convenience-of-the-employer rule.
- Normal work days spent at home may need to be entered as `US-NY` if your assigned office is in New York.
- Limitation: weekend work (for example, Sunday travel or Saturday meetings) is not yet modeled; weekends are always excluded.
- Schwab import: the CSV export is missing data; use API JSON instead.

## Usage

1. Create and enter a data directory, e.g. `my-rsus/`
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
   any physical work state. Overlapping work-location intervals are errors.

1. `npm run dev -- /path/to/data/`
