### apprenticeship-cycle-sla side effects

Risk reviewed: overdue-cycle attention spam.

Mitigation:

- The feature ships disabled by default at `monitoring.apprenticeshipCycleSla.enabled = false`.
- When enabled, `ApprenticeshipCycleSlaMonitor` records raised cycle ids in memory and raises at
  most one attention item per overdue cycle id.
- The monitor is observe-only: it reads `ApprenticeshipCycleStore`, computes age from `createdAt`,
  and never closes, edits, or deletes cycle rows.
- The server reuses `TokenLedgerPoller`'s existing cadence through an after-tick hook, avoiding a
  new independent polling loop.

Operational note: dedup is process-local. A server restart may allow one fresh attention item for an
already-overdue cycle, but the default-off gate prevents surprise rollout noise and the route remains
available as a pull surface.
