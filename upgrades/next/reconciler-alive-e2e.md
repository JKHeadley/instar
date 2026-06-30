<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Adds the missing Tier-3 "feature is alive" E2E test for the WS1.3 OwnershipReconciler (the
cross-machine stuck-move fix): `tests/e2e/pool-reconciler-alive-lifecycle.test.ts`. It
starts a real `AgentServer` with the reconciler wired and asserts over HTTP that
`GET /pool/reconciler` is alive (200, not 503), reports both machines, and that one
reconciler tick CONVERGES a pinned topic (owner != pin → transferring toward the pin
target), with the live status route reflecting the transfer. Test-only; no runtime change.
This completes the unit + integration + e2e three-tier coverage the Testing Integrity
Standard requires — the reconciler previously had unit + integration but no tests/e2e/
feature-alive test (the tier that catches "the dependency wasn't wired" defects, the class
the boot-ordering bugs belonged to).

## Evidence

- `tests/e2e/pool-reconciler-alive-lifecycle.test.ts` — 4 tests, all pass locally
  (`vitest run --config vitest.e2e.config.ts`): route alive (200), decision explanation
  (transfer), the tick converges (status `transferring`, transferTo = peer, lastReport
  transfers = 1), and auth (401/403 without a Bearer token).
- No source files changed (test-only); `tsc --noEmit` clean.
