# Side-Effects Review — Lifeline Stage C chaos / stress tests

**Version / slug:** `lifeline-stage-c-chaos-tests`
**Date:** `2026-04-20`
**Author:** `echo`
**Second-pass reviewer:** `not required (test-only addition; no decision logic shipped)`

## Summary of the change

Adds `tests/integration/lifeline/stage-c-chaos.test.ts` — 8 integration scenarios that compose the real Stage-B modules (MessageQueue on disk, RateLimitState on disk, LifelineHealthWatchdog, RestartOrchestrator with an injected exitFn, DegradationReporter singleton) and drive each failure mode through the full trip → rate-limit-write → quiesce → persist → exit chain. Also adds `docs/specs/LIFELINE-STAGE-C-CHAOS-TESTS-SPEC.md` documenting the plan. Zero production-code changes.

Files touched:
- `tests/integration/lifeline/stage-c-chaos.test.ts` (new)
- `docs/specs/LIFELINE-STAGE-C-CHAOS-TESTS-SPEC.md` (new)
- `upgrades/side-effects/lifeline-stage-c-chaos-tests.md` (this file)
- `.instar/instar-dev-traces/<ts>-lifeline-stage-c-chaos-tests.json` (new)

## Decision-point inventory

No new decision points. The tests exercise decision points that already shipped in Stage B (PR #87). Every scenario reads existing watchdog / orchestrator / rate-limit logic without mutating any production file.

- `LifelineHealthWatchdog.evaluate` — pass-through (exercised by S2, S3, S7)
- `RestartOrchestrator.requestRestart` — pass-through (exercised by all restart-path scenarios)
- `rateLimitState.decide` — pass-through (exercised by S4, S5)
- `isRestartStorm` / storm signal — pass-through (exercised by S5)
- `MessageQueue` persistence — pass-through (exercised by S6)

---

## 1. Over-block

No block/allow surface — over-block not applicable. Tests only observe.

## 2. Under-block

No block/allow surface — under-block not applicable. Tests only observe.

## 3. Level-of-abstraction fit

Right layer. Stage C tests sit at the module-composition layer: they compose the real Stage-B substrate (queue + rate-limit + watchdog + orchestrator + reporter) and drive chaos scenarios against it. They deliberately don't load the full `TelegramLifeline` (which drags in config detection, supervisor, tmux, poll loops) because that surface is exercised by existing unit tests and e2e paths. The right layer for "prove Stage B's substrate holds under chaos" is the substrate itself.

Tests do NOT spawn a child lifeline process. That path has been evaluated and rejected as expensive and flaky without meaningful marginal coverage — each piece the spawned process would exercise is already covered by a combination of (a) the 86 Stage-B unit tests, (b) the existing `telegramForwardHandshake` integration test, and (c) this new substrate composition test.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The test file adds no runtime decision logic. It spies on `DegradationReporter.report` to assert the storm signal fires — that's observation, not gating. The injected `exitFn` on RestartOrchestrator is the already-shipped test seam; no new injection points added.

## 5. Interactions

- **Shadowing:** N/A — tests run in an isolated `tmpdir` state directory and do not touch global singletons beyond `DegradationReporter.resetForTesting()` (which every DR-using test already calls).
- **Double-fire / race:** S8 exercises the shadow-install defer path; orchestrator re-entering `idle` is observed, not raced. Async-await boundaries in S2/S3 are handled with `setImmediate` flush loops — pattern matches existing orchestrator unit tests.
- **Cleanup races:** `afterEach` removes each test's tmpdir. No shared disk state between scenarios.
- **Infrastructure:** uses existing `DegradationReporter.resetForTesting()`, `RestartOrchestrator._resetForTesting()`, `MessageQueue` atomic writes, and `writeRateLimitState` atomic writes — all production helpers with existing coverage.

## 6. External surfaces

None. No routes, messages, or dispatch changes. No alteration to any file shipped in the npm package (`tests/` is excluded from `files` in package.json). Nothing is visible to other agents, users, or systems.

## 7. Rollback cost

Zero. Revert the PR. Tests disappear; production behavior is unchanged at all points since no production file is touched.

---

## Conclusion

Test-only addition, documentation-level runtime impact. No new decision logic. No second-pass reviewer required. Side-effects review concludes: safe to ship.
