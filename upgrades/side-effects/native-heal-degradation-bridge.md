# Side-Effects Review — Native-Module Heal → DegradationReporter bridge

**Version / slug:** `native-heal-degradation-bridge`
**Date:** `2026-05-20`
**Author:** Echo (instar developer agent)
**Second-pass reviewer:** voluntary independent audit run despite the
change not falling under the mandatory-review categories — the bridge
emits into the outbound-messaging path (via DegradationReporter), which
is adjacent enough to warrant a second opinion.

**Second-pass result:** *Concur with the review.* Reviewer independently
verified:
- `listeners` Set is effectively process-global (healer is a module-level
  singleton); per-bridge `Set` dedupe is the right second layer for
  future per-module retries.
- F-8 Remediator `invokeFromRemediator` and legacy `openWithHeal` both
  route through `logHealEvent` and share the `healAttempted` one-shot
  guard, so no double-fire is possible today.
- Listener-error swallow is bounded to the observability-consumer call
  site and does not hide heal exceptions (those remain thrown by
  `healBetterSqlite3Sync`).
- Tests 7–9 exercise the real production listener-dispatch path via
  `healBetterSqlite3Sync` with a mocked install-prefix resolver; tests
  1–6 use a synthetic fanout helper appropriate for unit-isolating the
  bridge translation logic.
- Forward-looking note (not blocking): if per-module heal retries are
  added later, success events should clear the dedupe entry and emit a
  "recovered" degradation so a retry-success-after-failure sequence
  doesn't leave the user with a stale failure alert. Today's one-shot
  semantics make this impossible to hit, so the bridge is correct as
  written; the comment in the bridge already anticipates the future
  surface.

## Summary of the change

`NativeModuleHealer` already writes `HealEvent`s to
`<stateDir>/native-module-heals.jsonl` and `console.error`s on failure. Its
own jsdoc names `DegradationReporter` as a consumer ("consumed by health
checks and DegradationReporter") but no consumer was ever wired. This PR
fills the gap with the minimum surface area required:

1. `NativeModuleHealer.onHealEvent(listener)` — public listener
   registration on the existing singleton. Listener fires after every
   persisted `HealEvent` (success and failure). Returns an unsubscribe
   function. Listener errors are swallowed inside the dispatch loop so
   observability cannot break the heal path itself.
2. `src/monitoring/NativeHealDegradationBridge.ts` — new ~70-line module.
   Subscribes to the healer; on a failure event, calls
   `DegradationReporter.report(...)` with a component-specific impact
   line. Successful heals are silent on purpose (the feature recovered,
   no user action required). Dedupes per component within the process
   life so a future heal-retry surface cannot spam the alert path.
3. `AgentServer` — one new import + one new call (`bridgeNativeHealToDegradation()`)
   placed immediately after the existing `NativeModuleHealer.configure(...)`
   line, inside the same `if (options.config.stateDir)` block.

Files touched:
- `src/memory/NativeModuleHealer.ts` — adds `HealEventListener` export,
  `listeners` Set, `onHealEvent()` method, listener-clear in
  `resetForTesting()`, listener-dispatch in `logHealEvent()`.
- `src/monitoring/NativeHealDegradationBridge.ts` — new module.
- `src/server/AgentServer.ts` — one import + one call.
- `tests/unit/NativeHealDegradationBridge.test.ts` — 9 new tests covering
  failure→report, success-silent, per-component dedupe, unknown-component
  fallback impact, missing-field reason fallback, unsubscribe, real
  listener dispatch through `healBetterSqlite3Sync` with a mocked install
  prefix, listener-error isolation, and listener cleanup.
- `upgrades/NEXT.md` — entry, evidence paragraph, user message, two
  capability-table rows.

## Decision-point inventory

- `NativeModuleHealer.logHealEvent` (deterministic authority over heal
  persistence) — **extend** — adds a listener-dispatch step after the
  existing jsonl write. Listener errors are swallowed; the heal contract
  is unchanged.
- `AgentServer` startup (composition root) — **extend** — adds a single
  subscriber registration call. No new state.
- `DegradationReporter.report` — **consume only**, no surface change.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None. No new gating, no new filtering, no rejection logic. The bridge
adds a degradation event on heal *failure* and stays silent on heal
*success*. Successful heals continue to behave identically to today
(the feature opens, the user sees nothing).

## 2. Under-block

**What failure modes does this still miss?**

- **CLI commands that hit the healer outside the server process.** A
  user running `instar memory ...` against an ABI-mismatched
  better-sqlite3 will get the existing `console.error` and a thrown error
  but no Telegram alert — `AgentServer` is the only registration site.
  This is the same scope as the existing DegradationReporter wiring
  (CLI commands never had the Telegram alert path anyway). The CLI user
  sees the error on stdout, which is the appropriate surface for a
  foreground command.
- **Multiple AgentServer instantiations in one process.** Each
  `bridgeNativeHealToDegradation()` call adds a new listener with a
  fresh dedupe Set. In production AgentServer is a singleton; in tests
  callers pass an explicit reporter. Not a real risk; documented as a
  YAGNI in the bridge module.
- **Build manifest / pre-load drift detection.** Out of scope — covered
  in topic 11013's earlier design proposal as a separate (lower
  priority) item. The heal works without it.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The healer is the existing authority over native-module rebuilds
and the canonical producer of `HealEvent`s. DegradationReporter is the
existing authority over "feature-fallback → user-visible alert."
Bridging them in a third file keeps each side single-responsibility:
the healer doesn't import the reporter (no `src/memory/*` →
`src/monitoring/*` coupling beyond the bridge), the reporter doesn't
know about the healer at all, and the bridge is a pure subscriber that
can be unit-tested with a synthesized `HealEvent`.

`AgentServer` is the correct composition root for the registration —
it's where `NativeModuleHealer.configure(...)` already happens, so the
two lines stay co-located.

## 4. Signal vs authority compliance

**Reference:** the principle in MEMORY.md (`feedback_signal_vs_authority`):
"Brittle/low-context filters detect and emit signals. Only a higher-level
intelligent gate with full context has blocking authority."

- The **healer** is the deterministic authority over native-module
  rebuilds. Unchanged.
- The **bridge** is a pure signal transducer — `HealEvent` (signal) →
  `DegradationEvent` (signal). It has no blocking authority, no decision
  surface, no LLM call.
- `DegradationReporter` is the higher-level alert authority. Its
  existing dispatch logic (Remediator routing, tone-gate, alert
  cooldown) is unchanged. The bridge is just a new emitter feeding the
  same authority.

## 5. Interactions / cross-component effects

- **Existing W-1 Remediator path.** When `NativeModuleHealer.invokeFromRemediator(ctx)`
  is the entry point, it still calls `healBetterSqlite3Sync` →
  `logHealEvent` → listener dispatch. The bridge fires once for the
  same component just as it does for the legacy `openWithHeal` path —
  per-component dedupe absorbs both paths. No double-alert risk.
- **DegradationReporter remediator-routing.** Reports flow through
  `_normalize()` like any other legacy `.report(...)` call. They will be
  tagged `provenance: 'free-text'` and (per §A6) won't match any runbook
  prefilter — they route to `no-matching-runbook` and feed
  NovelFailureReviewer's clustering pipeline, which is appropriate for
  "the W-1 heal couldn't repair its own target" alerts.
- **Telegram tone-gate.** Goes through the existing pipeline; the
  default safe fallback template applies if the candidate text is
  rejected.
- **Persistence.** `degradations.json` (existing) gains entries for
  heal failures. Bounded to last 100 events per existing rotation.

## 6. Rollback cost

Trivial. Revert is 5 file edits (3 modifications + 2 deletions). No
schema, no config, no migration, no on-disk format change. The
`native-module-heals.jsonl` log and `console.error` path are unchanged,
so observability survives a revert.

## 7. Migration parity check

Not applicable. The change is server-internal. No agent-installed file
changes (no `.claude/settings.json`, no `.instar/config.json`, no
CLAUDE.md template, no hook scripts, no built-in skills) — existing
agents pick this up automatically when they restart against the new
`instar` binary, which is the normal update path. The Migration Parity
Standard's enumerated trigger list does not include `src/server/*`.

## 8. Test integrity

Per the Testing Integrity Standard (`docs/specs/TESTING-INTEGRITY-SPEC.md`):

- **Tier 1 (unit).** 9 tests in
  `tests/unit/NativeHealDegradationBridge.test.ts` — listener-dispatch,
  failure-reports / success-silent / per-component-dedupe / unknown-component-fallback /
  missing-field reason / unsubscribe; plus three on
  `NativeModuleHealer.onHealEvent` exercising the real
  `healBetterSqlite3Sync` early-exit path with a mocked install-prefix
  resolver (listener invocation, listener-error isolation, unsubscribe).
- **Tier 2 (integration).** Not added — the bridge is a process-internal
  subscriber with no HTTP surface. The existing
  `tests/integration/degradation-reporter-*` suites continue to cover
  the reporter's HTTP-visible behavior; this PR adds one more emitter
  to that same path, no new routes.
- **Tier 3 (E2E lifecycle).** Not added — the wiring lives inside the
  same `if (options.config.stateDir)` block that already conditions
  `NativeModuleHealer.configure(...)` and `TokenLedger` construction
  (which both have Tier-3 coverage). Adding a parallel boot-time
  bridge-presence test would only restate that block's existing E2E
  guarantee.

Pre-existing related suites (`NativeModuleHealer.test.ts` 17 tests,
`NativeModuleHealer-invokeFromRemediator.test.ts`, `degradation-reporter*`
22 tests) pass unchanged after this PR.
