# New York RSU Income Calculator

## Background

New York tax rules require calculating the percentage of vest time that was spent working in New York for every RSU tranche whose vest period overlapped with NY workdays ([NYS Regulation Section 132.18(a)](https://www.law.cornell.edu/regulations/new-york/20-NYCRR-132.18), [TSB-M07(7)I](https://www.tax.ny.gov/pdf/memos/income/m07_7i.pdf), [Instructions for Form IT-203-F](https://www.tax.ny.gov/pdf/current_forms/it/it203fi.pdf)).

This program reads your RSU grant and vest data as well as your declared New York workdays and computes NY taxable income from RSUs for all vest years.

## Limitations

- You must encode New York's legal sourcing rules into `work-location.csv` yourself.
  In particular, remote days worked outside New York for your own convenience
  may still need to be entered as `US-NY` under the convenience-of-the-employer rule.
- Normal work days spent at home may need to be entered as `US-NY` if your assigned office is in New York.
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

1. Any working weekday not covered by `work-location.csv` is treated as non-NY.
   Overlapping work-location intervals are treated as errors.

1. `npm run dev -- /path/to/data/`
