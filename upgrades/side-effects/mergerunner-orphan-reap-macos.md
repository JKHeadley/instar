# Side-Effects Review — MergeRunner orphan reap works on macOS and keeps unconfirmed live records

**Version / slug:** `mergerunner-orphan-reap-macos`
**Date:** `2026-10-21`
**Author:** `Echo`
**Second-pass reviewer:** required — see below

## Summary of the change

ACT-141. `src/monitoring/MergeRunner.ts` `reapOrphan()` confirmed a leftover safe-merge's identity only through `/proc/<pid>/environ` (absent on macOS, the production host), and `reverifyAndClear()` deleted the in-flight record even when the recorded pid was alive and unconfirmed. Now: the attempt token also rides argv (`--attempt-token`, added to `scripts/safe-merge.mjs`'s strict allowlist and capabilities; passed only when the probed script advertises `attempt-token`) and is read with `ps -o args=`, `/proc` environ kept as a Linux fallback; an alive-but-unconfirmed record is kept (`reapIncompleteAt`), `reapOrphan()` returns `orphan-reap-incomplete`, and `run()` first resolves any surviving record and returns `skipped:orphan-unresolved` while it is alive and unconfirmed. `src/monitoring/GreenPrAutoMerger.ts` treats that outcome as non-ladder, non-breaker, with one deduped attention line, and audits a kept warm-up reap as `orphan-reap-incomplete`. Implements docs/specs/local-verify-merge-authority.md §2 step 4.

Second-pass additions: (a) the identity match also requires the pinned safe-merge path on argv, not only the token pair; (b) the pid-reuse wedge is bounded on positive evidence — the record now stores the attempt's `deadlineMs`; once `startedAt + deadlineMs + mergeKillGraceMs + 5 min` has passed, a live unconfirmed pid is cleared WITHOUT a kill (after re-verifying PR state, audited `orphan-presumed-foreign`) ONLY when the `ps -o args=` read succeeded and the argv shows no safe-merge. Elapsed time alone is not evidence: the default `--auto` path's gh calls carry no timeout, so a hung safe-merge can outlive its deadline. A failed read, or a safe-merge argv without our token (e.g. an older attempt), keeps the record. A legacy record without `deadlineMs` uses `mergeTimeoutMs`; (c) the stale-line fix — clearing the "Auto-merge is paused" line now re-posts the attention aggregate, and a successful warm-up reap also clears it; (d) `run()` resolves any surviving record at the start of EVERY attempt, so a confirmed live orphan is group-killed there too, not only at warm-up (reported via `MergeRunResult.priorRecord` and audited).

## Decision-point inventory

- `MergeRunner.verifyAttemptToken` — modify — argv token (exact word pair) first, `/proc` environ second.
- `MergeRunner.reapRecord` (from `reapOrphan`) — modify — alive + unconfirmed now keeps the record instead of clearing it.
- `MergeRunner.run` pre-check — add — resolve any surviving record at the start of every attempt: kill a confirmed live orphan, refuse while a kept record's pid is alive and unconfirmed (within its time bound).
- `MergeRunner.reapRecord` time bound — add — alive + unconfirmed past the attempt deadline + grace + 5 min → cleared unsignalled, `orphan-presumed-foreign`.
- `GreenPrAutoMerger.recordOutcome` — add — `skipped:orphan-unresolved` is non-ladder.
- `safe-merge parseArgs` — modify — accepts `--attempt-token <hex>` (identity only).

---

## 1. Over-block

A live, unrelated process that reused the recorded pid (pid reuse) blocks auto-merge, since it cannot be told apart from an unconfirmable own child — but a reused pid stops blocking once `startedAt + deadlineMs + mergeKillGraceMs + 5 min` has passed (about 6 min on the `--auto` path, about 30 min on the sync/admin path) AND its argv reads successfully and shows no safe-merge; then the record is cleared without a kill (`orphan-presumed-foreign`) and merging resumes. If `ps` cannot read the process, or it is a safe-merge we cannot prove is ours, the block stays (no time limit) — the deliberate cost of never running two merges side by side. During the bound it is surfaced by one attention line, which is cleared (and the aggregate re-posted) when attempts resume. `ps` failing transiently gives one refused tick, retried next tick.

---

## 2. Under-block

A leftover spawned by a safe-merge that predates `--attempt-token` on macOS still cannot be confirmed (no argv token, no /proc) — it is now kept and blocks rather than being ignored, which is the safe side. The dead-leader/live-group corner (leader exited, other group members alive) is unchanged: a dead pid is cleared without signalling the group. A hung safe-merge past its deadline is never presumed foreign (its argv names safe-merge), so it keeps blocking until it exits or is ended — the safe side.

---

## 3. Level-of-abstraction fit

Right layer: the runner owns the durable in-flight record and all process I/O; the orchestrator only classifies outcomes. The argv read mirrors the existing `readProcessArgs` seam in `src/localVerify/serviceSeams.ts`.

---

## 4. Signal vs authority compliance

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Yes, deterministic safety guard on an irreversible action (killing a process group / starting a merge) — not a judgment call.

The refusal is a fail-closed safety guard on irreversible actions (kill, merge); safe-merge stays the act-time authority. The check is an exact token match, not a heuristic.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The rule (identity proven → kill; unproven + alive → keep and wait; gone → re-verify and clear) is an invariant on an irreversible action, stated by the spec.

---

## 5. Interactions

- **Shadowing:** the pre-check runs before the hash/env checks in `run()`; a kept record therefore wins over a contract skip, which is intended.
- **Double-fire:** warm-up reap and the run() pre-check share `reapRecord`; both are inside the single-flight path, so no concurrent reaps. run() now group-kills a confirmed live orphan at the start of every attempt, not only at warm-up; identity requires both the token pair and the pinned safe-merge path on argv (or the Linux environ token).
- **Races:** the record is written/cleared atomically as before; a kept record is rewritten once (marker set only if absent).
- **Feedback loops:** the skip feeds neither the per-PR ladder nor the breaker, so a long block cannot give up a PR or trip the breaker; the attention line is posted only when not already present.

---

## 6. External surfaces

- safe-merge argv gains an optional identity flag; old callers unaffected; MergeRunner passes it only when the probed script advertises it.
- Persistent state: optional `reapIncompleteAt` and `deadlineMs` fields in `state/green-pr-automerge-inflight.json` (old readers ignore it).
- Operator surface: one attention line ("Auto-merge is paused …"), self-clearing — clearing re-posts the aggregate so the operator does not keep seeing a stale pause; no operator action required. No new operator actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface (no dashboard/approval/form files) — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the in-flight record names a pid on THIS machine and only the lease holder runs merges. A lease move leaves the record on the old machine, where it is resolved at that machine's next acting tenure; the new holder has its own record. The attention line goes through the existing aggregate (one voice, lease holder). No URLs.

---

## 8. Rollback cost

Pure code revert, next patch. A kept record left behind is cleared by the old code at the next reap. No migration.

---

## Conclusion

Closes both halves of ACT-141 with tests on each side (confirmed → killed; unconfirmed + alive → kept and refuses; unconfirmed + gone → cleared; pid-less unchanged; a real child identified through the real `ps` read on macOS). Clear to ship in the operator's review PR.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (three rounds)
**Independent read of the artifact: concur (after fixes)**

Round 1 raised: the pause note was never re-posted when cleared; pid reuse could wedge auto-merge with no time bound; identity should also require the pinned safe-merge path; the artifact said no review was needed and omitted the wedge and the start-of-run kill. Round 2 raised that the time bound assumed safe-merge always exits by its deadline, which the `--auto` path does not. Now a past-deadline record is cleared only on positive evidence (a successful `ps` read whose argv names no safe-merge at all); a failed read or any safe-merge argv keeps it, with the pause note visible. Round 3 concurred.

## Evidence pointers

`tests/unit/merge-runner.test.ts`, `tests/unit/green-pr-automerger.test.ts`, `tests/unit/safe-merge-hardening.test.ts`; 316 targeted unit tests + 30 integration (green-pr routes, safe-merge local floor) pass.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect (prompt/hook/config/skill/standards) and no new self-triggered controller (an existing reap path is made more conservative) — not applicable.
