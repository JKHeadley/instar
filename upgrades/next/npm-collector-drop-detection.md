# npm collector: drop and gap alerts, and day/week comparisons by calendar date

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

The operator telemetry script `scripts/collect-metrics.py` now detects a weekly npm download drop (below 60% of the previous calendar week or of the previous run) and interior zero-download gaps, writes `change_notes` as objects with a `kind`, and prints them in its summary. The spike check compares a day with the calendar day before it rather than with the previous run, and `trends.npm_week_prev` is now the sum of the seven calendar days before the current week instead of the reading from seven runs back. Not part of any agent's runtime.

## Evidence

- `python3 -m unittest discover -s scripts/tests`: 50 tests pass. Restoring the old row-to-row spike rule fails the two skipped-run-cadence tests.
- Replaying the real telemetry ledger: the 2026-11-02 run no longer reports a spike (11-01 8,887 vs 10-31 10,359), and the 2026-11-05 week-over-week figure is −3.1% (62,440 vs 64,450), matching the hand-computed value where the old baseline gave +10.9%.
