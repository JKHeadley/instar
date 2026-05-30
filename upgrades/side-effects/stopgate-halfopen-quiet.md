# Side-effects — Stop-gate breaker half-open quiet

**Change:** `UnjustifiedStopGate.evaluate()` now reports `breakerOpen` (instead of
`timeout` / `llmUnavailable`) for a provider failure that (re)opens the breaker.

## Behavioral side-effects

- **The `/health` degradation count no longer creeps while the breaker is open.**
  Previously each per-cooldown half-open retry of a still-down provider emitted a
  fresh `timeout`/`llmUnavailable` degradation; now those report the suppressed
  `breakerOpen` kind. The count caps at `breakerThreshold - 1` (default 2) instead
  of climbing indefinitely, and `/health` can return to `ok` once the initial
  failures age out.
- **The breaker-opening failure is now categorized `breakerOpen` in the stop-gate
  audit DB / log**, not `timeout`/`llmUnavailable`. Anyone reading the stop-gate
  log sees the breaker open at the threshold-th failure rather than seeing K
  identical timeouts then a separate open. The provider IS still called on that
  failure (call counts unchanged); only the reported kind changes.
- **The fail-open decision is unchanged.** `breakerOpen` allows the stop exactly
  like `timeout` did — agents stop on a degraded gate identically. No behavior
  change to when/whether a session may stop.
- **No change with the breaker disabled.** `breakerThreshold: 0` short-circuits
  `onProviderFailure()`; `breakerOpenUntil` stays 0; failures report
  `timeout`/`llmUnavailable` exactly as before.

## Blast radius

- Scoped to `src/core/UnjustifiedStopGate.ts` (one catch block). No route change
  (the route already suppresses `breakerOpen` from #559). No config, schema, hook,
  or migration changes. No new dependencies.

## Migration parity

None required — internal runtime logic in `src/`. Existing agents receive it on
their normal version update; no agent-installed file to migrate. Builds on #559's
breaker which already shipped fleet-wide.
