# Side-effects review — login-loss account swap

The change extends the existing proactive live-session account swap with one
new source trigger: explicit local-login loss (`owner-relogin-required` or
`missing-local-login`). It does not add a second executor, credential store, or
session lifecycle path.

## Decision-point inventory

- Source candidacy — modified — quota pressure or exact login-loss evidence.
- Untagged source identity — modified — real config-home correlation survives
  the expected failure of the auth-status probe.
- Kill-boundary authority — modified — source identity and login-loss evidence
  are both revalidated before SessionRefresh.
- Rollout authority — added — nested development-agent gate plus dry-run-first.

## 1. Over-block

A login-loss session holds when its real config home is unavailable, the
conversation is not refreshable, target readings are stale/hot, work is busy,
the ledger/breaker/dwell refuses, or the source condition repairs before the
kill boundary. These are intentional safe-direction refusals.

## 2. Under-block

Only the exact owner-relogin-required/missing-local-login drift class bypasses
quota source pressure. Other identity drift remains quarantined and cannot
authorize a restart. A target must still be local, same-framework, non-drifted,
freshly measured, and beneath the existing ceiling.

## 3. Level-of-abstraction fit

`ProactiveSwapMonitor` remains the level-triggered intent owner,
`SwapAntiThrashEngine` remains the brake/target authority,
`QuotaAwareScheduler` remains the execute-time revalidator, and
`SessionRefresh` remains the sole session mutation funnel.

## 4. Signal vs authority

Subscription-pool identity drift is a signal until it matches the enumerable
login-loss state. The actual mutation authority is the conjunction of that
state, exact real-config-home source identity, refreshability, target validity,
all anti-thrash brakes, work-idle evidence, and the repeated kill-boundary
checks. Uncertainty holds.

## 5. Interactions

- Untagged sessions use real config-home correlation because auth status is
  expected to fail after login loss.
- A repaired login invalidates an in-flight intent before the kill.
- Dry-run writes a scrubbed `sourceTrigger:login-loss` would-swap row without
  consuming a session refresh.
- Quota-trigger behavior is unchanged.

## 6. External surfaces

No new route or notification exists. The nested config block exposes
`enabled` and `dryRun`; defaults omit `enabled` and seed `dryRun:true`.

## 7. Multi-machine posture

Machine-local by design: login presence and the session's real config home are
local execution facts. The target remains a locally executable account; no
credential is copied between machines.

## 8. Rollback cost

Disable `subscriptionPool.proactiveSwap.loginLoss` or revert. Existing quota
swaps remain available. No database migration or durable repair is required;
older ledger readers ignore the optional source-trigger field.

## Class-Closure Declaration

- `unbounded-self-action` — closed by the existing proactive-swap controller
  guard and ratchets. The level trigger is bounded by dwell, work deferral,
  failure backoff, per-target and per-cycle caps, breaker, and source repair;
  `tests/unit/swap-continuity-wiring.test.ts` proves dry-run, live, and
  kill-boundary settling behavior.

## Evidence

- `tests/unit/swap-continuity-wiring.test.ts`
- `tests/unit/proactive-swap-production-wiring.test.ts`
- `tests/unit/devGatedFeatures-wiring.test.ts`
- `tests/unit/lint-dev-agent-dark-gate.test.ts`
- The execution-path comment preserves the review's key boundary: login loss
  bypasses source pressure only, while every target and kill-time guard remains.
