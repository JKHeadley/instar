# Side-effect review — remediation boot reconciliation

## Changed boundary

`AuditWriter` hydrates its existing recent-tail read view from the durable
projection during construction. `RemediatorBootstrap` invokes that view and
`IntentJournal.readSince()` through a dedicated reconciler before it registers
the live Remediator with the degradation path.

## Expected effects

- Restarted remediation processes retain a bounded hot audit window.
- Recent intent-without-audit gaps produce one boot warning with a count.
- The bootstrap result exposes reconciliation counts for diagnostics and tests.

## Bounds and failure behavior

- Audit hydration reads at most 1,000 rows and two megabytes from the file tail.
- Intent scanning uses an asynchronous stream rather than blocking on a full
  synchronous read; malformed individual lines retain the existing skip rule.
- The comparison uses a five-minute overlap before the oldest retained audit
  row so the intent that immediately preceded it remains visible.
- Reconciliation is signal-only. It never retries, rolls back, or performs a
  remediation, and an old intent outside the retained audit window is not
  misclassified as a current mismatch.

## Class-closure declaration

This closes a dormant-reader wiring class at bootstrap. The dedicated unit test
proves both readers are invoked, and the bootstrap test proves persisted rows
survive construction and reach the reconciliation result.
