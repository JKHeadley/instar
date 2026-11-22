# Side-Effects Review — turning autoApply off cancels a queued update

**Version / slug:** `autoapply-off-cancels-queued-update`
**Date:** `2026-11-20`
**Author:** `Echo (builder #44)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 2 source files (`src/core/AutoUpdater.ts` +~80 lines, `src/server/routes.ts` ~10 lines) plus 3 new test files. Effort: no spec rounds (Tier 1), one build pass.

`AutoUpdater` gains `setAutoApply(value, source)`, which records the setting and, when it is turned off, clears an armed coalescing timer (`applyTimer`) and its `coalescingUntil` marker and persists state. The automatic apply step (timer callback and the zero-delay path) now goes through `applyQueuedUpdate()`, which re-reads `updates.autoApply` (`reloadDynamicConfig`) immediately before calling `applyPendingUpdate()` and returns without installing when it is false. Every runtime change to the setting goes through `setAutoApply`: `reloadDynamicConfig` (both the LiveConfig and the direct-file branch), a new LiveConfig `change` listener for `updates.autoApply` (reads `newValue` from the event, because LiveConfig emits before swapping its cache), and `PATCH /updates/config`, which previously poked `(autoUpdater as any).config.autoApply`. The tick's "auto-updates off" branch also cancels a queued apply. The PATCH response gains `cancelledQueuedUpdate`. `applyPendingUpdate()` itself (shared with manual `POST /updates/apply`) is untouched.

## Decision-point inventory

- `AutoUpdater` automatic apply (timer / zero-delay) — modify — now refuses when autoApply is false at apply time.
- `AutoUpdater.tick` autoApply-off branch — modify — additionally cancels an armed timer.
- `PATCH /updates/config` — modify — routes through `setAutoApply` (cancels a queued apply when turning off).
- Manual `POST /updates/apply` — pass-through — unchanged.

---

## 1. Over-block

The only thing that can now be refused is an automatic install while `updates.autoApply` is false. That is exactly the setting's meaning. One edge: the LiveConfig default for an absent key is `true`, so deleting the key does not cancel anything (unchanged semantics). A person who turns auto-updates off and back on within the delay loses the queued timer; the next check (30 min) re-queues it. Acceptable: the update is delayed, not lost, and `pendingUpdate` stays set for a manual apply.

## 2. Under-block

A config file edit is observed by LiveConfig's 5-second poll, so the listener cancels within ~5 s; if the timer fires inside that window, the apply step's own re-read (`liveConfig.get` re-reads on mtime change) still refuses. Remaining gap: an apply that has already started (`isApplying`, npm install running) is not interrupted. Interrupting a half-done install would be worse than finishing it; not attempted.

## 3. Level-of-abstraction fit

Right layer: the AutoUpdater owns the timer, so it owns cancelling it. The route now calls a method instead of writing a private field, removing an `as any` reach-in.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over messages or agent behaviour; it makes an existing operator setting authoritative over the automatic install it already governed.

The check is a boolean config read the operator owns, not a heuristic detector.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point: the setting is the operator's explicit instruction (an invariant), not one signal among several.

## 5. Interactions

- **Shadowing:** `applyPendingUpdate`'s own guards (`isApplying`, no pending update) still run after the new check.
- **Double-fire:** the LiveConfig listener and `reloadDynamicConfig` can both observe the same change; `setAutoApply(false)` is idempotent (second call finds no timer and returns false).
- **Races:** the timer callback nulls `applyTimer` before `applyQueuedUpdate`; a concurrent `setAutoApply(false)` then finds nothing to clear and the re-read refuses. `stop()` already cleared the timer and is unchanged.
- **Feedback loops:** clearing `coalescingUntil` lets the next tick send the "auto-updates are off" notice once (it doubles as the notified marker); verified by a test that two ticks send exactly one notice.
- Restart deferral / dampener / loop-breaker paths are untouched.

## 6. External surfaces

- `PATCH /updates/config` response adds `cancelledQueuedUpdate` (additive).
- `state/auto-updater.json` is written when a cancel happens (`coalescingUntil: null`), same schema.
- One extra notice is possible: after a cancel, the next check sends the existing "auto-updates are off" message once, which before was suppressed by the stale `coalescingUntil` timestamp. This is the intended notice for that state.
- No operator-facing action added; the existing "turn auto-updates off" path now does what it says.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: each machine runs its own AutoUpdater over its own install and reads its own `config.json`; the timer and its cancellation are per-process. `updates.autoApply` itself travels the way config already does. No new notices beyond the existing one (which already goes through `notify`), no durable state that strands, no URLs. Status surface: `GET /updates/auto` (`coalescingUntil` now goes null on cancel) is this machine's view, unchanged in scope.

## 8. Rollback cost

Pure code change: revert the commit and ship a patch. No data migration; persisted state uses the existing fields.

## Conclusion

Closes the hole found in the Windows dress rehearsal: autoApply false set inside the coalescing window was ignored. The design adds two independent guards (cancel on change, re-check at apply time) so either alone is sufficient. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read the diffs and code, not this conclusion)
**Independent read of the artifact: concur**

Every runtime path that changes the setting goes through `setAutoApply`; reading `newValue` from the LiveConfig event is correct because LiveConfig emits before swapping its cache; the timer clears `applyTimer` before awaiting, so a late cancel falls through to the apply-time re-read; manual `POST /updates/apply` is unaffected. Noted, non-blocking and pre-existing: a non-boolean `"false"` string in config is treated as true by the listener while `reloadDynamicConfig` stores the raw value.

---

## Evidence pointers

- `tests/unit/AutoUpdater-autoapply-cancel.test.ts` (9 cases: both orders, file / LiveConfig / setAutoApply paths, notice-once, manual apply, positive control) — 6 fail on main, all pass with the fix.
- `tests/integration/updates-config-autoapply-cancel.test.ts` (PATCH through AgentServer) — 2 of 3 fail on main.
- `tests/e2e/autoapply-off-cancels-queued-update-lifecycle.test.ts` (started LiveConfig + AutoUpdater + AgentServer, real timers, config-file edit) — the edit case fails on main.
- Source report: Windows dress rehearsal, builder #43, 2026-11-20.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in the updater; the timer is a pre-existing self-triggered action whose firing this change only narrows, never widens).
