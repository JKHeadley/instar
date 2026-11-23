# Side-Effects Review — Shadow runner prerequisites (context budget Phase 2 slice P2-4a)

**Version / slug:** `cb-p2-runner-prereqs`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** independent subagent (see the end of this file)
**Spec:** `docs/specs/context-budget-layered-summaries.md` (v9, converged, approved) §7.2 (ask brakes), §7.3, §7.4 (audit), §9.3 (step 0, lock renewal, carriers), §10 (suppression carrier), §16 Phase 2, §11
**Stacked on:** P2-3b (#3561) → #3555 → #3551 → #3543

## Summary of the change

These are the deterministic pieces the shadow runner (P2-4b) composes, plus its switch and its read surface. Nothing here starts a fold, and no new loop runs.

1. **Switch `contextBudget.fold.shadow`.** Registered in `DEV_GATED_FEATURES`: omitted means live on a development agent and dark on the fleet. It has no `ConfigDefaults` key (omission is the default) and needs no migration. The justification owns the live effects the runner will have (spec decision 13).
2. **`FoldCoordinator.setLockWindow` and `renew`.**
   - `setLockWindow` records the §10 lock-window entry bounds in the fold sidecar AND in a durable per-topic log (`lock-windows.jsonl`, read with `readLockWindows`). The log outlives the record's settle, so a consumer reading after a shadow fold went terminal still skips the range.
   - `renew` refreshes the keyed lock at the same generation while a step reports progress (§9.3 step 1). It is refused unless the record is still the coordinator's, at the caller's generation, under the same ownership epoch. A quarantined record, whose lock is the sentinel's, is refused.
   - Both are owner-only and refused on a terminal record.
3. **`removeFoldMarkerFor(stateDir, instarSessionId, foldId)`.** Removes ONE session's marker, and only if it names this fold. A shadow fold uses it to release the LIVE session's marker at handoff-turn end, while the answerer's marker stays with the record (§9.3 step 0).
4. **`foldSuppression` ignores `shadow-probing` records.** At that point the live session has already been released (§9.3 step 0), so its per-prompt context must not be muted while the throwaway answerer is graded. `prepared` (the handoff turn) still mutes.
5. **`foldAudit.ts`** (§7.4), a tier-1 audit:
   - **Signal check in both directions:** a finished-but-open PR or a red test is contested; completed work the handoff didn't mention is a question.
   - **Model verdict** (`FoldAudit`, fenced, enumerated: `accept` or `send-back`, plus `protectedDefect`).
   - **Send-back policy:** one send-back, then one more only for a DETERMINISTIC protected-class defect. That defect is `droppedDecisions`: a live ledger decision bound inside a folded stretch that the handoff neither quotes nor keeps. Then the contested spans are demoted, and a handoff the audit still rejects with nothing to demote is declined.
6. **`foldCleanStop.ts`** (§7.3, §7.2):
   - **`cleanStop`:** tri-state evidence, where any unknown means not clean, with a named reason. Covers the check-in distance against the fold duration × 2.
   - **`openBackgroundTasks`:** run_in_background (Bash, Agent) or Monitor starts since the last fold, minus completions reported in task-notification blocks, each block parsed on its own. Start ids are read from the shapes Claude Code actually writes. A start whose id can't be read counts as open.
   - **Ask brakes:** 2 asks per topic per rolling hour, a 30-minute backoff, a reproducible 1-in-3 shadow sample. Stored as a 0600 JSON file per topic.
7. **`foldHandoff.buildHandoffRequest`.** The internal handoff-request turn. It carries a bounded message index (the session never sees message ids), is marked internal, and gives the JSON schema `parseHandoff` accepts.
8. **`foldShadowLog.ts`** plus **`GET /context-budget/fold-shadow`.** One JSONL row per shadow-fold attempt (graded, skipped, declined, aborted), using the DeltaShadowLog pattern: 0700/0600, one rotated segment of 2 MB, counts only. The summary covers progress toward the 40-fold Phase 2 exit, the pooled would-be lost rate, would-roll-back and protected-loss counts, reasons, and engines. The route is 503 while the switch is off. It has a CapabilityIndex entry and an endpoint listing.
9. **Awareness entry** `src/data/awareness/context-budget-shadow-folds.md`. Tells agents to read the record rather than guess, and how to treat the internal handoff request.

**Files.** New: `foldAudit.ts`, `foldCleanStop.ts`, `foldShadowLog.ts`, the awareness entry, unit tests (`fold-audit` 12, `fold-clean-stop` 25, `fold-runner-prereqs` 11) and integration `fold-shadow-route` (3). Modified: `FoldCoordinator.ts`, `foldMarker.ts`, `promptContext.ts`, `devGatedFeatures.ts`, `foldHandoff.ts`, `routes.ts`, `CapabilityIndex.ts`.

**Size and effort.** Tier 2, about 520 LOC of source. The runner's integration points were mapped first by a research subagent. Tests and lint passed on the first full run (962 neighbouring unit tests).

## Decision-point inventory

- **Per-prompt hook suppression** (modify). A `shadow-probing` record no longer mutes the hook. This is narrower muting, never wider.
- **Clean stop, ask brakes and audit step** (add). Deterministic inputs and policy for the runner. They decide nothing on their own.
- **The route** (add). A read surface.

## 1. Over-block

None. The suppression change only un-mutes. The brakes and the clean stop make asking rarer, never more frequent.

## 2. Under-block

- **`openBackgroundTasks` reads the id from the start's tool result.** An id the regex can't read counts as open. That is not clean, which is the safe direction: at worst a shadow fold is skipped.
- **The audit's semantic check depends on the model.** Its output is enumerated, and code applies the send-back policy and demotion.

## 3. Level-of-abstraction fit

Each piece sits beside the module it extends: the coordinator API, the marker module, the hook suppression, the existing log pattern, the existing `/context-budget/*` read family and CapabilityIndex prefix, and the dev-gated registry.

## 4. Signal vs authority compliance

Compliant. Everything new is a signal or a deterministic input. The one behaviour change, suppression, removes muting.

## 5. Interactions

- **`foldSuppression`:** today no record ever reaches `shadow-probing` (no runner exists), so the change is behaviour-identical until P2-4b. The `fold-open` and `fold-stale` paths are unchanged for every other state.
- **Coordinator renew and lock window:** new methods only. No existing call changes.
- **Dev-gated registry:** the both-sides wiring test (`devGatedFeatures-wiring`) now covers the new switch, and passes.

## 6. External surfaces

- A new bearer-only read route.
- A new awareness paragraph in every agent's instructions, rebuilt on update with no migration.
- On development agents the switch reads live, but there is no runner yet, so nothing happens.

## 7. Multi-machine posture

Machine-local by design. Brakes, the log, fold records and markers live on the topic's owner (§9.3 owner-only). The route reports this machine's record. A pooled read is not needed for the Phase 2 exit, which is measured on the dev agent's owner.

## 8. Rollback cost

A revert. The log and brake files become inert. The awareness paragraph disappears on the next update.

---

## Second-pass review

(appended below by the reviewer)

Concern raised:

1. **`renew` renews a quarantined fold's sentinel lock** (`src/monitoring/FoldCoordinator.ts:484-490`). It adopts `rec.role`, and `quarantined` is not terminal, so after `quarantine()` hands the lock to `role: 'sentinel'`, a stale runner calling `renew(topic, foldId)` gets `true` and extends the sentinel's lease. I reproduced this with a scratch test: begin → snapshotted → staged → replacing → quarantine → `renew` returned true. The docstring says it refuses "a lock this hand does not hold", but it cannot tell hands apart. A runner that reads `true` as "still mine, carry on" is wrong. It also skips the `ownerEpoch` check that `transition` makes. Fix: take the caller's expected `{generation, role:'coordinator'}` (or refuse `quarantined`/`role !== 'coordinator'`) and check `ownerEpoch`. The §9.3 "each renewal re-stamps the marker files" is also not done here.
2. **The lock-window carrier is deleted at the terminal transition** (`setLockWindow` at `FoldCoordinator.ts:470`; `settle()` calls `dropSidecar`). I verified that after `aborted` the sidecar reads `{"staged":[]}`. §10 says the enumerated consumers (TopicMemory ingestion, intent extractor, correction learning, TokenLedger tagging…) "skip that range". Any consumer that reads after the fold goes terminal, which for a shadow fold is the "aborted-by-design" end, loses the bounds, and the internal handoff turn gets ingested as conversation. The docstring ("the sidecar is the carrier consumers read") does not hold once the record is settled. The bounds need a home that outlives settle, or P2-4b must name which consumers read them before settle.
3. **The extra send-back's trigger comes from the model, but the spec makes it deterministic** (`src/monitoring/foldAudit.ts:111-116`). `allowed = 1 + (v.protectedDefect ? 1 : 0)` uses the model's `protectedDefect` flag. §7.4 and the §12 row ("deterministic trigger for the extra send-back") both require a deterministic trigger, and the module header claims one ("a dropped ledger decision or a contradicted Anchor"). A dropped ledger decision can be checked by code against the ledger rows. Also, `demote-contested` with `spans: []` (the model is still unsatisfied and no signal is contested) lets the fold go ahead on a handoff the audit rejected. It should decline (`fold-declined: audit`) instead.
4. **`openBackgroundTasks` id regex** (`src/monitoring/foldCleanStop.ts:91`). The bare `task\s*(...)` alternative matches the first "task <word>". For the result text "Monitor task started. Task ID: mon12345" it captures `started`, so the start never closes. An Agent `run_in_background` result (`agentId: …`) is not read at all. Both count as open. That is the safe direction, but `afterEntry` is the last fold's boundary, so the session can then never reach a clean stop and never folds: shadow folding starves for any session that used Monitor or a background agent. The completion regex's lazy `[\s\S]*?` can also cross from one `<task-notification>` into the next and credit the wrong task id (reproduced). These text shapes are ones I built myself. Phase 0's per-engine shape check should pin the real ones, and the regex should be anchored to them.
5. **"Counts only, never words" is not enforced on the served rows** (`src/monitoring/foldShadowLog.ts:35-39`, `src/server/routes.ts` fold-shadow handler). `handoff.deficiencies`, `packet.problems` and `reason` are free strings, and the route returns `recent` rows raw. Existing detail strings carry conversation text: `foldPacket.ts:327` `still-needed-missing` puts `item.slice(0, 80)` in its detail. If P2-4b logs details instead of codes, words reach the route. Fix: type those fields as code enums or counts, or strip them in `appendShadowFold`.
6. **Artifact claim:** it says `fold-runner-prereqs` has 11 tests. It runs 8 (total unit 39, not 42). All 39 unit tests and the 3 integration tests pass.

Checked and fine: `cleanStop` ordering and the tri-state handling (an overdue check-in counts as not clean); the brake arithmetic (rolling hour, backoff, reproducible sha256 1-in-3 sample after the brakes, and stopSeq advancing on every clean stop); the `shadow-probing` un-mute is consistent with §9.3 step 0 and §10, because the answerer stays suppressed by its own marker; the route's bearer gate and 503 when dark; the `buildHandoffRequest` excerpts are collapsed to single lines at 80 chars; the audit prompt fences with escaping.

### Disposition (author)

All six concerns verified and fixed:
1. **`renew`** now takes the caller's `{generation}`. It refuses a quarantined record, a non-coordinator role, a generation mismatch and a changed ownership epoch. Tested on a fold quarantined after `replacing`. Re-stamping markers after a renewal is stated as the caller's duty, and the runner does it.
2. **Lock window outlives settle.** It is appended to `fold-records/lock-windows.jsonl`, merged per fold and bounded to 500. That name does not match the record pattern, so the boot sweep never reads it as a record. Tested: after `aborted` the sidecar is gone and `readLockWindows` still returns the bounds.
3. **Deterministic protected trigger.** `droppedDecisions(handoff, ledger)` is computed in code. `nextAuditStep` takes it as `{protectedDefect}` and ignores the model's flag for the extra send-back. A still-rejected handoff with nothing to demote is now `decline`. Tested on both sides.
4. **Background-task shapes.** The parser is anchored to the three start shapes Claude Code writes (Bash `Command running in background with ID: X.`, Monitor `Monitor started (task X,`, Agent `agentId: X`), observed in this session's own transcript. It reads one notification block at a time, so an id never crosses blocks. Tested, including the reviewer's two strings.
5. **Codes only** is enforced in `appendShadowFold` (`codesOnly`). Tested with detail text, plain words and non-code list entries: none reach the file.
6. **Test counts** are corrected: `fold-audit` 11, `fold-clean-stop` 24, `fold-runner-prereqs` 10. 611 neighbouring unit tests and 17 integration tests pass. Lint 54/54.


### Reviewer re-check:

Fixes 1, 2, 3 and 6 hold. I checked them in code and with scratch tests:
- **1:** `renew` refuses a wrong generation, and refuses a quarantined record at both the old and the new generation.
- **2:** `readLockWindows` returns the merged bounds after a `rolled-back` settle.
- **3:** `droppedDecisions` is computed in code, and a rejected handoff with nothing to demote now returns `decline`.
- **6:** the counts are now 11, 24 and 10, and the 3 integration tests pass.

Concern raised:

1. **A forged task-notification can close an open background task. This errs in the unsafe direction** (`src/monitoring/foldCleanStop.ts`, the `texts` loop in `openBackgroundTasks`). Notification blocks are read from every record type: assistant `text` blocks and user string content alike. In a scratch test, a real Bash start (`Command running in background with ID: bz4k2m9.`) read as 1 open. A later assistant text block or an operator message that quoted `<task-notification><task-id>bz4k2m9</task-id><status>completed</status></task-notification>` took it to **0 open**. That makes a clean stop look true while the task is still running, which §7.3 forbids ("unknown ⇒ not clean"). It can happen without any malice, for example an agent quoting or discussing a notification (this review did exactly that). Fix: accept completions only from the record shape Claude Code uses to inject notifications (a `user` record whose content is the notification, not assistant text and not an operator row). Add a test that an assistant-text or operator-text block does not close a task.
2. **Minor: `codesOnly` keeps single plain words** (`src/monitoring/foldShadowLog.ts:51`). `CODE` (`^[a-z0-9][a-z0-9_.-]{0,63}$`) matches any lowercase word. In the scratch test, `reason: 'password'` and `problems: ['hunter2', …]` both reached the row unchanged. The disposition says plain words do not get through, but a one-token word or secret does. Fix: check against the known code sets (the deficiency, problem and reason enums), or require a hyphenated code as `SUB_CODE` does.
3. **Minor: the lock-window log is bounded on read, not on disk** (`FoldCoordinator.ts:611-636`). `appendLockWindow` appends forever. `LOCK_WINDOW_MAX_ROWS` only slices what is read, so the disposition's "bounded to 500" describes the reader and the file still grows without limit (Bounded Accumulation). The same function also swallows an append failure silently. After settle, that failure is exactly the loss concern 2 was about, so it should at least raise a degradation record.
4. **Minor, protected trigger with contested spans** (`foldAudit.ts:129-137`). When `protectedDefect` is true and other spans are contested, the third pass returns `demote-contested` with only the signal-contested spans. The finished stretch that holds the dropped decision is not demoted, so the fold proceeds with that stretch folded. Add the spans `droppedDecisions` found to the demotion set (or decline).

### Disposition (author), round 2

All four re-check findings verified and fixed:
1. **Forged or quoted notifications.** Completions are read ONLY from the record shape Claude Code injects: a `user` record whose whole content (or single text block) starts with `<task-notification>`. A notification quoted in assistant text, or in an operator message (`[telegram:…] … <task-notification>…`), never closes a task. Tested with assistant text, assistant string content and an operator row; the injected shape still closes it.
2. **Plain words as codes.** A code must now be a hyphenated token, or one of five known single-word codes (`backoff`, `oversize`, `redacted`, `schema`, `empty`). Tested: `password` becomes `redacted`, and `hunter2` is dropped.
3. **Lock-window log bounded on disk.** On append, past 256 KB, the file is compacted (atomic rename) to the newest 500 merged rows. An append failure makes `setLockWindow` return `false`, which the runner records. Tested: 3,000 windows stay under 300 KB, with the latest bounds kept.
4. **Dropped-decision stretches demoted.** `droppedDecisions` now returns `{keys, spans}`. `nextAuditStep` takes `droppedSpans` and demotes them together with the signal-contested ones. Tested.

### Reviewer re-check 2:

Concur with the review. What I checked, in code and with scratch tests:
- **1 (notifications):** the injected `user` string, and a single text block, both close the task (0 open). A notification quoted in assistant text, in a `[telegram:N]` operator row, or in an unrelated tool_result leaves it open (1).
- **2 (codes):** `isCode` accepts only hyphenated lowercase tokens or the five known single words, so `password` becomes `redacted` and `hunter2` is dropped. A hyphenated lowercase token can still get through (accepted residual: the runner supplies codes, never details).
- **3 (lock-window log):** it compacts on disk past 256 KB through tmp-and-rename to 500 merged rows, and an append or compaction failure makes `setLockWindow` return false.
- **4 (dropped decisions):** `droppedDecisions` returns the spans and `nextAuditStep` merges `droppedSpans` into the demotion set, so a stretch with a dropped decision is never folded.
- **Tests:** fold-audit 12, fold-clean-stop 25 and fold-runner-prereqs 11 = 48, all passing.

Residual, not blocking: a raw operator message typed into the pane with no channel prefix that begins with `<task-notification>` would still count as a completion.
