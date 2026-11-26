# Side-Effects Review — local-verify merge line: queue place kept, today's base, merge-in-order hand-off

**Version / slug:** `local-verify-merge-line`
**Date:** `2026-10-23`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see bottom)`
**Reviewer:** independent general-purpose subagent (Claude), see "Second-pass review"

## Summary of the change

CMT-980 (topic 128243). Tier 2 (the change is on the merge authority path: `LocalVerifyService`, `GreenPrAutoMerger`). Size: 14 files, ~800 lines added, ~20 removed (about half tests). Effort: three review rounds on the artifact (rounds 1 and 2 each raised one blocking finding in the same in-flight hand-off seam, both fixed below); eight commit-free test iterations (four were my own test-harness bugs: a stale input file read, a non-hex sha, a fake PR list that never drops a merged PR, a fake base reader that also stalled the request path).

Problem: the local verifier ran one PR at a time, and every time `main` moved the watcher's next tick dequeued each queued PR and re-pushed it with a fresh `firstQueuedAt`, so a PR went to the back of the line on every `main` move (CMT-973; PR 2320 queued 02:12 UTC, re-pushed seven times, started 09:26). A PR whose verify passed then waited for the watcher's next 10-minute tick, while the verifier started the next PR against the pre-merge `main`. There was no way to merge in order.

The change (spec `docs/specs/local-verify-merge-authority.md` §2 "The merge line (amendment 2026-10-23)"):

1. `src/localVerify/LocalVerifyService.ts` — **kept place (CMT-973)**: in `request()`, a queued PR whose base moved has its `baseSha` refreshed in place (audit `base-updated`), keeping position, `firstQueuedAt`, `pausedMs`, `starvedRaised`; a moved head takes the old entry's slot and `firstQueuedAt` (audit `queued` + `keptPlace`). **Pre-start base refresh**: `pump()` asks `decideBaseRefresh` (pure) whether the next PR entry should re-read the base head (`main` moved since the entry's base was resolved — a merge the line made or a head the reconcile loop saw — or it waited 5 min); if so `refreshBaseThenPump` reads `seams.baseHead` with the entry still queued, audits `base-refreshed` / `base-refresh-failed` (a failed read starts on the last known base), derives a record when identical inputs are already green (`derived-at-start`), then pumps again. **Hand-off**: `complete()` calls `offerMerge`, which (via `decideMergeHandoff`, pure) hands a green PR record to the late-bound `setMergeHandoff` function and holds the queue (`mergeHold`) until the answer or `MERGE_LINE.handoffMaxMs` (30 min); a `merged` answer sets `mainMovedAt` so the next PR re-reads its base. `snapshot()` gains `mergeLine`. `QueueEntry`/the durable queue gain `baseResolvedAt`.
2. `src/monitoring/GreenPrAutoMerger.ts` — `tick({ handoff: { pr, head } })`: the same pass as a tick (lease, latches, breaker, floor transition, armed reconciliation, warm-up, list, gather) but the target is exactly the verified (pr, head) or nothing (`handoff-not-eligible:<why>`), it runs only on the local floor, requests no verifies, and waits for an attempt in flight (`inFlightDone`) instead of feeding the busy-skip breaker. `act()` records `lastActOutcome` so the hand-off answers the real outcome.
3. `src/localVerify/localVerifyWiring.ts` — `wireMergeLine()`: the production hand-off: kill switch (`monitoring.localVerify.mergeLine`, read live), post the head's status through the reconcile loop's serialized writer (`pass()` first for an unlisted head, then `submit`), read it back, and hand off only when GitHub holds `success` (live posting) — then `watcher.tick({ handoff })`. `src/localVerify/StatusReconciler.ts` gains three read methods (`knowsHead`, `headState`, `postingLive`). `src/commands/server.ts` calls `wireMergeLine` right after `attachLocalVerify`.
4. `src/testing/selfActionRegistry.ts` — `local-verify-merge-handoff` controller (one hand-off per record, never re-offered). `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` — agent awareness (Agent Awareness + Migration Parity). Spec + ELI16 amended; release fragment `upgrades/next/local-verify-merge-line.md`.

## Decision-point inventory

- Queue admission on a re-request — modify — a moved base updates in place, a moved head keeps the slot; the record/execution-dedupe/queue-full checks are unchanged.
- Start admission — modify — a PR entry may first re-read its base (bounded: one read per start, then `baseResolvedAt = now`, so it cannot loop); `pump` refuses while a read or a merge hold is open.
- Verify completion — add — a green PR record opens ONE hand-off; the hold is a capacity pause (no authority over the merge).
- Watcher target selection — add — hand-off mode selects exactly (pr, head) from the SAME eligible set gather() built; every refusal path of a tick is kept.
- Watcher single-flight — modify (hand-off only) — waits for the attempt in flight instead of a breaker feed; regular ticks unchanged.

## 1. Over-block

- A hand-off whose status is not yet `success` on GitHub (post failed, head unlisted, loop in dry-run? no — dry-run proceeds) is NOT handed off and the queue hold ends at once (`status-<state>`): the PR is merged by the regular tick as before. No PR is refused that was mergeable before.
- A head pushed during the PR's own run used to go to the back on cancel (`keptPlace` was only set for queued entries); it now takes the front with the cancelled run's `firstQueuedAt` (round-1 S2).
- A hand-off whose "list this head first" pass coincided with the 60 s loop's pass got `busy` and answered `status-absent`; the wiring now awaits the running pass (`awaitPass`) (round-1 S4).
- A hand-off that waits on an attempt in flight gives up after the attempt's deadline + kill grace + 1 min (`handoff-wait-timeout`, no save, left to the tick).
- The queue hold itself can delay the next verify by up to 30 min when the watcher answer is slow (a hung sync merge). Before, the next verify would have started at once against the stale base and the merge would have waited for the tick anyway, so the line's total latency is not worse; the hold is bounded and audited (`merge-handoff-result` with `heldMs`).
- A `main` verify queued during a hold also waits. Bounded by the same 30 min; the `main` debounce is 10 min anyway.
- A base read that fails right before a start lets the run go on the last known base (not a refusal); a request-time failure still refuses `pr-unreadable` as before.

## 2. Under-block

- The hand-off merges a record whose base is behind the current `main` when `main` is healthy — exactly what §3 already admits (the base is not pinned) and what the next tick would have done; the context carries `baseIsCurrentMain` for the audit, and the post-merge `main` verify stays the compensating control. During `main-suspect`/`main-red`, safe-merge's own predicate refuses a record not on the current head (unchanged).
- A second green record arriving during a hold (a derived record from a request) is left to the tick (`merge-handoff-skipped: hold-active`), never queued behind the hold: no unbounded hand-off queue.
- (Round-1 BLOCKING, fixed) The hand-off's wait on an in-flight attempt was released from `act()`'s `finally`, one microtask BEFORE the owning tick saved its state, so the hand-off reloaded stale state and its later save erased that tick's episode/ladder/breaker writes (a refused head lost its no-re-spawn pin). Now the release is OWNED: `act()` keeps it as a local and returns it on its result (`settle`) only when THAT call spawned the attempt; the owning tick calls it in a `finally` AFTER `saveState`. A test with a copy-on-load/save store proves the pin survives.
- (Round-2 BLOCKING, fixed) The first fix kept the release in a shared field, so an overlapping tick (two ticks can both pass the top-of-tick busy check before either spawns) could release another tick's waiter early or replace its release so the waiter never woke (a hand-off hung to the 30-min timeout). Now `act()` re-checks `inFlight` immediately before the spawn (`skipped:busy-in-act` — the in-process single flight the top check was meant to be) and the release is owned as above; the hand-off waiter is bounded (`handoff-wait-timeout` after the attempt deadline + kill grace + 1 min) and polls when no promise is attached. A test with two overlapped ticks proves the non-owning tick spawns nothing and neither frees nor drops the owner's waiter. An unsettled attempt (`inFlightDone` set, owner not yet saved) counts as busy everywhere (round-3 S9), so the invariant "an attempt is over only when its owner has saved" is in code, not in event-loop phase ordering. A bookkeeping throw after a landed merge answers `error:post-run` (`acted:false`): `mergeLine.merged` under-counts that one and `mainMovedAt` is left to the reconcile loop's next head observation (≤60 s); accepted.
- The watcher's hand-off wait (`while inFlight await inFlightDone`) narrows but does not remove the pre-existing overlap window between two concurrent ticks that both pass the busy check before `inFlight` is set (awaits in `act()` before `runner.run`). That window exists today for interval ticks; the MergeRunner's durable in-flight record (`priorRecord` / `skipped:orphan-unresolved`) remains the real single-flight guard. Stated, not widened.
- A hold can time out mid-merge when the hand-off first waited on an in-flight attempt (≤25 min) and then ran its own (≤25 min): the next PR then starts on the pre-merge base (which §3 admits) and the late answer is audited `merge-handoff-late-answer`; a late `merged` still sets `mainMovedAt`, so the start after that re-reads its base. The guarantee degrades for one PR, visibly, never silently.
- `decideBaseRefresh` uses a strict `>` on `mainMovedAt` versus `baseResolvedAt`: a base resolved in the same millisecond as a `main` move is not refreshed. Real reads take longer than a millisecond; the 5-minute age rule and the watcher's own re-request (in-place `base-updated`) cover it. Deliberate: `>=` with a frozen clock would re-refresh forever.

## 3. Level-of-abstraction fit

The queue rules live in the service that owns the queue (`request`/`pump`, pure `decideBaseRefresh`/`decideMergeHandoff` beside the existing `decideStart`/`decideVerifyRetry`). The merge itself stays in the watcher (`tick` with a target) and safe-merge; the service only hands over a (pr, head) and pauses. The status post goes through the reconcile loop's existing serialized per-head writer (`submit`), not a second poster. The composition (`wireMergeLine`) is in the wiring module next to `buildLocalVerifyService`, and server.ts calls one function.

## 4. Signal vs authority compliance

No new blocking authority. The hold is a capacity pause with a hard time bound; a refused or timed-out hand-off changes nothing about what merges (the tick path is intact). The watcher's hand-off mode reuses `gather()` + `act()` + safe-merge: the authorities are the same functions. The pre-start base refresh changes the INPUT of the verify (today's base), never a verdict. The status gate (`headState !== 'success'` ⇒ no hand-off) is fail-safe toward "wait for the tick".

## 5. Interactions

- Watcher ticks keep running every 10 min; a tick that finds the handed-off PR already merged records `merged-by-other`; a tick during a hand-off's run sees `inFlight` and busy-skips as today (one busy-skip per overlapping tick, same as any 25-min sync merge).
- The restart hold (`restartHolds`) covers a running verify; during a merge hold no verify runs, so an auto-update restart is not held by the verifier — but the update gate's own `success`-head hold (spec Restarts (a)) still applies. A restart during a hold loses only the hold (in memory); the record is journaled before the offer, and the boot rebuild never re-offers (the watcher merges it at its first acting tick).
- `shutdown()` during a hold: `stopped` makes the hold's `pump()` a no-op; the waiting entries are in the durable queue (tested).
- The self-action registry gains `local-verify-merge-handoff` (K=3 over 40 ticks, per-target 1); the existing `local-verify-*` models are untouched. `lint-no-unregistered-self-action` is report-only and lists nothing new.
- The StatusReconciler's `submit` from the hand-off is one more post trigger through the same rate-limited writer (`admitPost`); a deferred post leaves the state unchanged and the hand-off answers `status-<state>` (no merge attempt).
- Each hand-off runs one full watcher pass (list + gather + probe + refetch) and, for a head the reconcile loop has not listed, one reconciler pass: a bounded increase in GitHub API calls of about one pass per green record (round-1 external-surfaces note).
- `verifierVersion` is a content hash of the installed verifier code, and `LocalVerifyService.ts` is in that graph: when this ships, every green record made under the previous version stops matching at the next boot and those PRs are re-verified (the existing rule for any verifier change; the retained-queue places and the merge line make that cheaper than before).
- Measured before the change (Echo's live audit, 2026-10-23): PR 2320 `dequeued`/`queued` seven times across 02:12–23:53 UTC with a fresh `firstQueuedAt` each time; the live `queue.json` at 04:25 UTC 10-24 showed 2320 at position 3 with `firstQueuedAt` 01:25 UTC though first queued 02:12 UTC the day before.

## 6. External surfaces

- GitHub: the hand-off posts the `instar/local-verify` status (same writer, same dedupe) and runs safe-merge sync — both already happen; only the timing moves earlier. `GET /local-verify` gains `mergeLine` (additive). Config: `monitoring.localVerify.mergeLine` (absent ⇒ on).
- Timing dependence: the hand-off relies on GitHub reflecting the just-posted status before `gh pr merge`; the read-back is of OUR post result (not a fresh GitHub read), so a GitHub-side lag can still refuse the merge — that costs one ladder attempt, as a tick could today, and the next tick retries.

## 7. Multi-machine posture

Machine-local BY DESIGN, like the verifier: the queue, the hold and the hand-off run on the lease holder (the watcher and the reconcile loop are lease-gated; a standby's `tick` answers `not-lease-holder`, so a standby's hand-off is a no-op). A lease move during a hold leaves the record in the machine-local journal (as today) and the new holder merges at its first acting tick. No new durable state crosses machines; `baseResolvedAt` is in the machine-local `queue.json`.

## 8. Rollback cost

`monitoring.localVerify.mergeLine: false` (read live) stops hand-offs without a restart: the service reads it before a hold opens, so a disabled line books no hold, no counter and no audit, and `GET /local-verify` → `mergeLine.enabled` reads false (round-1 S1); merges return to the watcher's 10-minute ticks. Reverting the code with `baseResolvedAt` already in `queue.json` is safe: the restore mapper spreads unknown keys. Reverting the commit also restores the old re-queue behaviour (CMT-973 returns). Records and the journal format are unchanged (`baseResolvedAt` is an optional queue field; an older file restores with it absent, which just means a refresh at start). No data migration.

## Second-pass review

**Reviewer:** independent general-purpose subagent (Claude), three rounds, concurred in round 3

Round 1 (2026-10-23): **did not concur**. Blocking: the hand-off's wait on an in-flight attempt was released one microtask before the owning tick saved its state, so the hand-off's later save overwrote that tick's episode/ladder/breaker records (a refused head lost its no-re-spawn pin). Should-fix: the kill switch was read only in the wiring closure (holds/counters booked while off); a head pushed during its own run still went to the back; the 30-min hold could expire mid-merge with the late answer dropped; a `busy` reconcile pass answered `status-absent`; one-sided test boundaries; the hand-off answer could mislabel `armed` as `merged` via a shared field. Nits on audit reasons and `baseResolvedAt`.

Fixed: release ordered after `saveState`; `enabled` read by the service before a hold (`decideMergeHandoff` skip `disabled`, `mergeLine.enabled`); front-of-line for a mid-run push; `merge-handoff-late-answer` + `mainMovedAt` on a late merge; `awaitPass`; `act()` returns its outcome; tests for each. Round 2: **did not concur** — the ordered release lived in a shared field, so an overlapped tick (both past the top-of-tick busy check) could free another tick's waiter early or replace its release (a hand-off hung to the 30-min timeout). Fixed: the release is owned by the `act()` call that spawned (returned as `settle` on its result, called by the owning tick after its save), `inFlight` is re-checked right before the spawn (`skipped:busy-in-act`), the post-run bookkeeping always returns the release, the waiter is bounded; an overlap test with gated list calls proves the non-owning tick spawns nothing and neither frees nor drops the owner's waiter. Round 3: **concur**; no blocking findings; should-fix S9 (treat an unsettled attempt as busy everywhere) and S10 (tighten the overlap test's evidence) applied; nits (clock source for the wait bound, the no-save comment on `handoff-wait-timeout`, the `error:post-run` under-count) applied or recorded above.
