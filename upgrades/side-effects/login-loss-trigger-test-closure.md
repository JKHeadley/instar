# Side-Effects Review — login-loss trigger test and observability closure

**Version / slug:** `login-loss-trigger-test-closure`
**Date:** `2026-07-23`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `Codex safety-review agent`

## Summary of the change

The existing login-loss account-swap trigger is unchanged. This change exposes
its resolved `enabled` and `dryRun` posture through the existing proactive-swap
status response and adds dedicated HTTP integration and end-to-end coverage for
the already-merged trigger. The tests use the real subscription pool,
anti-thrash engine, ledger, monitor, and route; the swap executor remains
injected so the suite is hermetic.

## Decision-point inventory

- `ProactiveSwapMonitor.status()` — pass-through — reports the already-resolved
  login-loss rollout posture without changing it.
- Existing login-loss candidacy and swap authority — pass-through — exercised
  by tests but not modified.

## 1. Over-block

No block/allow behavior changes. The status field is observational and the new
tests do not participate at runtime.

## 2. Under-block

The tests do not emulate a real process kill or external authentication
provider. Those boundaries remain covered by the existing scheduler and
session-refresh tests. The new coverage specifically closes the missing route
composition and feature-alive tiers.

## 3. Level-of-abstraction fit

The posture is surfaced by the monitor that owns the resolved configuration,
through the route that already exposes that monitor's status. The tests compose
existing primitives rather than adding a parallel detector, executor, or
fixture-only implementation.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface.

The identity-drift signal and existing swap authority are unchanged. The new
status field is read-only provenance; the tests exercise the current authority
without adding one.

## 4b. Judgment-point check

No new static heuristic or competing-signals decision point is added.

## 5. Interactions

- **Shadowing:** none; the status data is appended to the existing response.
- **Double-fire:** none; the tests invoke one on-demand pass at a time.
- **Races:** the end-to-end promotion honors the existing dwell interval after
  the dry-run row instead of bypassing it.
- **Feedback loops:** none; reading status does not alter monitor state.

## 6. External surfaces

When the prerequisite anti-thrash pipeline is wired, the existing status
response gains an optional `loginLoss` object containing two booleans. Without
that pipeline the trigger is ineffective and the posture remains omitted.
Existing clients remain compatible. No notification, credential,
session-binding, persistence format, or operator action is added.

## 6b. Operator-surface quality

No operator UI surface — not applicable.

## 7. Multi-machine posture

Machine-local by design. A local login and a live session's real configuration
home are facts of the machine executing that session. The status reports that
machine's resolved posture. The change emits no user-facing notice, adds no
durable state, and generates no URL.

## 8. Rollback cost

Revert the status field and tests and ship a patch. No migration, cleanup, agent
state repair, or credential action is required.

## Conclusion

The change closes the requested integration and end-to-end evidence without
reimplementing or widening the live recovery authority. It is clear to ship
after the independent second-pass review concurs.

## Second-pass review

**Reviewer:** Codex safety-review agent
**Independent read of the artifact:** concur

The reviewer found no dark, dry-run, or session-lifecycle authority regression.
The review requested narrower wording for the injected swap-callback boundary
and explicit disclosure that posture visibility depends on the braked pipeline;
both precision corrections are incorporated above.

## Evidence pointers

- `tests/integration/subscription-proactive-swap-route.test.ts`
- `tests/e2e/subscription-proactive-swap-lifecycle.test.ts`
- `tests/unit/swap-continuity-wiring.test.ts`
- `tests/unit/proactive-swap-production-wiring.test.ts`

## Class-Closure Declaration (display-only mirror)

No new self-triggered controller and no new agent-authored decision defect. The
prior trigger's existing `unbounded-self-action` guard declaration remains the
machine-readable closure for its authority.
