# Side-Effects Review — Local Verify waiting list for queue-full refusals

**Version / slug:** `lv-fair-waiting-list`
**Date:** `2026-11-07`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose subagent (see below)`

## Summary of the change

Feedback fb-7fde7f49-8ee. A PR refused by `LocalVerifyService.request()` because the queue was at its cap got a `queue-full` audit row and nothing else, so a freed slot went to whichever caller reached `request()` next. New `src/localVerify/waitingList.ts` keeps a persisted list (`state/local-verify/waiting.json`, registry category `local-verify-waiting`) keyed by PR with `firstRefusedAt`, `lastOfferedAt` and a refusal count. In `request()`: every non-replay `queue-full` refusal joins the list; below the cap, an ordinary non-replay, non-kept-place request is refused (`queue-full`, audit `queue-full-waiting`) when the live waiters ahead of it are at least the free slots; an admitted waiter leaves the list and its `firstRefusedAt` goes onto the queue entry, the durable queue file and the `queued` / `started` audit rows. Waiters leave on close/merge (on offer and by a bounded 5-minute sweep in `tick()`), on a recorded result, on an untrusted head, after 6 h idle, or past a 200-entry cap. A failure re-run's new-base mark (`failureReruns`) is now spent only on admission. Also: `snapshot().waiting`, CLAUDE.md template line + `migrateClaudeMd` block, state registry entry. Tier 1 (a revert fully undoes it; the leftover file is ignored). Size: 3 src files changed + 1 new (~260 LOC), 5 test files. Effort: no spec rounds (Tier 1), one commit attempt planned.

PR discovery (read first, as asked): the only automatic caller is `GreenPrAutoMerger.requestVerifies`, every `tickIntervalMs` (600 s), offering every eligible PR in one pass sorted by `readyAt` ascending (when the review precheck started passing, or the PR's open time when no review is required), ties by PR number — oldest-ready first, so scan order did NOT favour newer PRs within a pass. The unfairness came from three things: (a) all refusals in one pass are forgotten, so the next pass after a slot frees re-races; (b) `readyAt` resets when a PR's approval drops and returns, which re-orders it behind newer PRs; (c) explicit `POST /local-verify` calls and service-internal re-runs arrive between passes and take a freed slot first. The list fixes all three because the order is decided at the service, by first refusal, whoever calls.

## Decision-point inventory

- `LocalVerifyService.request()` capacity admission — **modify** — below the cap, ordinary requests yield free slots to older live waiters.
- Full-cap refusal (`queue-full`) — **modify (bookkeeping only)** — the refusal also records a waiter; the refuse/admit outcome is unchanged.
- Main-red repair admission past the cap — **pass-through, unchanged**.
- Merge-throughput overflow past the cap — **pass-through, unchanged**; below the cap a labelled PR skips the waiting check (admitted as before).
- keptPlace re-queue — **pass-through, unchanged** (skips both checks, as before).
- Preflight replay admission — **pass-through, unchanged** (replays neither join nor wait; they have their own durable admission with backoff and a breaker that a new refusal reason would wrongly spend).
- `rerunFailures` (red→green) — **pass-through, unchanged** — the one-shot re-run passes `rerunAfterGreen` and is not held back by the list (nothing would offer it again; found by the second-pass review).
- Failure re-run spend (`failureReruns`) — **modify** — spent on admission instead of before the capacity check.

---

## 1. Over-block

A newer ordinary PR is now refused below the cap while older live waiters fill the free slots — intended. The worst unintended case: a waiter that is still being offered every pass but whose request never reaches the capacity check would not reserve (it isn't refreshed), so nothing over-blocks there. A waiter that IS offered reaches the check and, being oldest, is admitted on that same call, so a live waiter reserves for at most the gap until its next offer (≤ one 10-minute pass in practice, ≤ 30 minutes by rule). During that gap the queue still has ≥ 1 entry to run (the list never reserves when the queue is empty), so the verifier is never idle because of a reservation. Explicit POSTs from agents are subject to the list like watcher offers — deliberate, as explicit POSTs were one of the ways newer PRs jumped the line.

## 2. Under-block

A waiter that stops being offered gives up its reservation after 30 minutes of healthy running time; a newer PR may then get in ahead of it — intended (fairness yields to liveness). Ordering between two waiters that were first refused in the same millisecond falls back to PR number. The watcher's per-pass order still decides which never-refused PR is first to be refused, so first-refusal order inherits `readyAt` order for PRs that become eligible in the same pass. The 3-hour starved alarm still measures from `firstQueuedAt` (unchanged by design; the new `firstRefusedAt` makes the outside wait measurable without changing the alarm).

## 3. Level-of-abstraction fit

Right layer: the queue owns admission, and the service is the only place that sees every caller (watcher, POST route, re-runs). Doing it in the watcher would miss explicit POSTs and re-runs. The list is a sibling of the durable queue file with the same atomic-write and corrupt-move-aside pattern.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over agent behaviour or information flow in the signal-vs-authority sense; it is queue ordering inside an existing deterministic admission authority.

The capacity check was already a deterministic authority over queue slots; this adds an ordering rule to it, not a brittle detector with new blocking power. The rule's inputs are enumerable facts (refusal time, last offer time, queue length, main health), not judgments.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point: FIFO by first refusal with a liveness bound is an enumerable ordering invariant (the same shape as the existing FIFO-within-priority queue).

## 5. Interactions

- **Shadowing:** the waiting check runs after the record / execution-dedupe checks and only in the `else` branch of the existing full-cap block, so it never runs for repair, throughput-overflow or keptPlace admissions; those code lines are untouched.
- **Double-fire:** none found. `rerunFailures` keeps its existing full-cap pre-check and is exempt from the list below the cap.
- **Races:** `request()` has awaits before the capacity stage; the waiting check, refusal record and queue push run synchronously with no await between them, so two concurrent requests cannot both take the one slot meant for the oldest waiter.
- **Feedback loops:** a refused request updates `lastOfferedAt`, which keeps the waiter live only while its caller keeps offering it — the loop ends when offers stop.
- **Restart hold / fb-7459b8b6-a7f:** nothing here touches restart holds, `PlannedRestartVerifyGuard`, `shutdown()` or peer holds. Open PRs touching `src/localVerify`: #2901 (placement) and #2374 (conflict notice) edit other regions of `LocalVerifyService.ts` (peer placement wiring; conflict recording) — no shared hunks expected; the restart-hold work for fb-7459b8b6-a7f had no open PR or local worktree when checked.

## 6. External surfaces

- `GET /local-verify` gains a `waiting` array (additive).
- Callers still see `queue-full` (HTTP 429) for a waiting-list refusal — no new code for callers to handle.
- New audit events: `queue-full-waiting`, `waiter-removed`, `waiting-restored`, `waiting-restore-unreadable`, `waiting-persist-failed`; new fields on `queue-full`, `queued`, `started`.
- New persistent file `state/local-verify/waiting.json` (≤ 200 records, replaced in place; heartbeat write at most every 5 min while non-empty).
- Operator surface: no operator-facing actions added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: the list describes this machine's queue, and only the serving-lease holder admits PR verifies (a peer-only service never loads or uses it). After a lease move the new holder starts with its own (usually empty) list, which is the prior behaviour; refused PRs rejoin on their next offer. No user-facing notices, no URLs, no status/health/capabilities routes changed (only the existing `/local-verify` read gains a field, scoped like the rest of that read: this machine).

## 8. Rollback cost

Pure code revert in a patch release. The leftover `waiting.json` is ignored by older code; the extra optional `firstRefusedAt` field in `queue.json` is ignored by the older reader (it spreads unknown fields harmlessly and drops them on its next write). No migration, no agent repair, no user-visible regression.

---

## Conclusion

Clear to ship. The review produced four design changes before commit: replays are kept out of the list (a refusal would have spent their bounded admission attempts); a failure re-run is now spent only on admission (otherwise a waiting-list refusal below the cap would waste it); the one-shot red→green re-run is exempt from the list (second pass: it would otherwise be lost for good); and a waiter refused while `main` was unhealthy is clamped to `now` when the clock resumes (second pass: it was stamped in the future and could hold a place for hours). How a waiter is prevented from holding a slot empty: it reserves only while live (offered within 30 min of healthy running time), only while `main` is healthy, never when the queue is empty, and is removed on close/merge/record/untrusted head, after 6 h idle, or past 200 entries.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (read-only; given the diff and the six requirements, not this artifact's conclusions)
**Independent read of the artifact: concern → resolved**

- Concern 1: `WaitingList.setHealthy` added the whole pause to waiters refused DURING the pause, stamping `lastOfferedAt` in the future (an explicit POST at +3h59m of a 4 h red spell stayed live ~4.5 h). Resolved: `lastOfferedAt = min(now, lastOfferedAt + paused)`; test "a waiter refused during the pause is never stamped in the future".
- Concern 2: `rerunFailures` skipped a re-run that live waiters would refuse, and nothing would ever offer it again (the watcher filters PRs with a record). Resolved: the re-run passes `rerunAfterGreen` and bypasses the list, as before; test "the one-shot red→green failure re-run is not held back".
- Confirmed by the reviewer: requirement 4 holds (repair needs a red `main`, where the list reserves nothing; throughput, replay, keptPlace skip the new branch); moving the re-run spend after admission is safe; no race in `request()`; growth bounded.
- Minor, accepted: a stale waiter that is offered again keeps its original `firstRefusedAt` and so regains its place (up to the 6 h drop) — it did wait first; and after a crash up to 5 minutes of idleness (one heartbeat) may count as downtime.

---

## Evidence pointers

`tests/unit/localVerify/waitingListService.test.ts`, `tests/unit/localVerify/waitingList.test.ts`, `tests/integration/local-verify-routes.test.ts` (429 + `waiting` in GET), `tests/e2e/local-verify-lifecycle.test.ts` (`waiting: []` on the production boot path), `tests/unit/PostUpdateMigrator-localVerifyMainRedHold.test.ts` (template + migration line).
