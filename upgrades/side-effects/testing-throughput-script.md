# Testing Throughput Report script side-effects review

- The new job is an opt-in sibling. The shipped manifest defaults to disabled, and the existing script runner gate also applies. When that gate is closed, the scheduler skips the sibling without model fallback. Existing schedules and their enable flags keep their current behavior on install and update.
- Missing or malformed journal and baseline inputs fail the script. The script saves one private plain-text report per scheduler run in the local report directory. It does not change the journal, run tests, read the model environment or call external services.
- The calculator reuses the historical inventory thresholds. Those thresholds classify the report's counts. Acceptance and queue authority remain with Local Verify. Exact publication latency is unavailable from the journal.
- Reports describe a machine-local journal. Queue sizes and the active revision come from a best-effort local snapshot. The existing AI job retains its inter-session delivery behavior.
- A cutover must coordinate the enabled state of the two jobs. Rollback disables the sibling and keeps the current report schedule and all saved reports available.
- The fixed fixture preserves the timestamps, outcomes, lane counts and aggregate results from the saved 22:26 UTC report. Its comparison covers both reporting windows, including rates and failfast exclusions.
