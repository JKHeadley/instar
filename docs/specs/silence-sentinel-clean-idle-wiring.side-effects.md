# Side-Effects Review — ActiveWorkSilenceSentinel A2(b) clean-idle wiring

**Version / slug:** `silence-sentinel-clean-idle-wiring`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `originates from instar-codey's optional-dep-default-audit (finding #5)`

## Summary of the change

`ActiveWorkSilenceSentinel` corroborates before escalating (HONEST-PROGRESS-MESSAGING A2): A2(a) live-frame "still working", A2(b) clean idle prompt, A2(c) live sub-agent. A2(b) reads `this.deps.isCleanIdlePrompt?.(frame, sessionName) ?? false`. That dep appeared exactly TWICE in `src/` — its declaration (`ActiveWorkSilenceSentinel.ts:102`) and its one use (`:390`). `buildActiveWorkSilenceDeps` neither accepted nor forwarded it, so no caller could supply it. **A2(b) was inert: a session at a finished prompt fell through to `proceedEscalation`** — a false "stuck" notice to the operator. This adds the option to the builder, forwards it, and supplies it in `server.ts` from the SHARED `IDLE_PROMPT_PATTERNS` export.

## Decision-point inventory

One decision point is **repaired, not added**: "is this quiet session actually wedged?" It had three intended corroborations and only two reachable. No new decision point; A2(a) and A2(c) untouched; escalation thresholds and cadence unchanged.

## 1. Over-block

Could this now suppress a REAL wedge? Only if a genuinely wedged frame matches the idle-prompt patterns. Those patterns are the narrow, shared set already trusted by `SessionManager`'s monitor loop and `ModelSwapService`'s swap-readiness check — the same source of truth, per that export's own docblock ("not a parallel copy that can drift"). A frame showing anything else still escalates. A control test asserts an omitted dep stays `undefined` so the sentinel's `?? false` default governs rather than being faked true.

## 2. Under-block

The previous behaviour WAS the over-escalation. Residual: a session wedged AT an idle prompt (rare — that is a finished turn by definition) is now cleared rather than escalated. That is the documented intent of A2(b); the paused-tracker flag is the other guard on that path.

## 3. Level-of-abstraction fit

The predicate is supplied at the bootstrap (only it can reach the shared patterns and the config), forwarded by the deps builder (which owns the sentinel's dependency surface), and consumed in the sentinel (which owns the corroboration order). The alternative — importing patterns inside the sentinel — would have created the parallel copy the export explicitly warns against.

## 4. Signal vs authority compliance

**Signal only.** The sentinel notifies; it does not kill or gate. This change makes it notify LESS in one specific, documented case. No exit code, route, or authority changes.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new judgment point. A substring match against a code-defined shared constant — deterministic, no model call, no threshold.

## 5. Interactions

Blast radius measured: `buildActiveWorkSilenceDeps` gains one optional field, so every existing caller compiles and behaves identically (absent ⇒ `undefined` ⇒ the pre-existing `?? false`). `IDLE_PROMPT_PATTERNS` gains one importer (`server.ts`), joining `SessionManager` and `ModelSwapService`. `PresenceProxy.ts:426` keeps its OWN local copy of idle patterns — the drift the shared export warns about; noted, NOT changed here.

## 6. External surfaces

None. No network call, file, persisted state, credential, telemetry, or route.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The operator-visible effect is FEWER false "session may be stuck" messages. No new text.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified. Per-machine sentinel over local tmux frames; no shared state, lease, or replication.

## 8. Rollback cost

Very low. Two source files, one test file, one commit; no migration, persisted state, config flag, or breaking signature change (the new option is optional).

## Conclusion

Ship. It reconnects a documented corroboration branch that has been inert, reduces false operator alarms, uses the canonical pattern source rather than a copy, and is guarded in both directions.

## Evidence pointers

- Inertness verified by count, not inference: `isCleanIdlePrompt` occurs exactly 2× in `src/` (declaration + use), against a control of `looksActivelyWorking` at 22×.
- The escalation path it bypasses read in source: `if (cleanIdle) { clear(); emit('recovered'); return; }` immediately above `proceedEscalation(... honestAskMessage ...)`.
- Negative control executed: removing the builder's forwarding line makes the new `THE DEFECT` test FAIL (1 failed / 41 passed) while the CONTROL passes. Source restored byte-identical (sha + 24,881 bytes).
- `tsc --noEmit` exit 0; `tests/unit/monitoring/sentinelWiring.test.ts` 42/42 (was 40).

## Class-Closure Declaration (display-only mirror)

Class: "an optional dependency whose default is indistinguishable from a real answer." Closed for `ActiveWorkSilenceSentinel.isCleanIdlePrompt`. **NOT closed** for the other 7 surfaces in Codey's audit (`ParallelActivityIndex.nicknameFor`/`purposeFor`, `ConversationRegistry.isJournalFsyncDisabled`, `TelemetryHeartbeat.agentCountFn`, `SessionManager.spawnAccountResolver`, `WriteAdmission.nicknameOf`/`selfNickname`), nor for `PresenceProxy`'s parallel idle-pattern copy.
