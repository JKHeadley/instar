# Side-Effects Review — a failed sign-in repair stops alarming once the account is verified back

**Version / slug:** `relogin-recovered-condition`
**Date:** `2026-10-26`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1 (declared), 4 src files (~120 LOC) plus tests; one build pass, no spec rounds. Evidence: episode 07a2d827 (Mac Mini, sagemind-luna) failed at 20:21:58Z with `repair-time-budget-exhausted`; its slow retry was scheduled at 20:22:28 and correctly unscheduled at 20:28:28 when the source incident closed (account signed in again). The terminal notice had been HELD (retry expected), was re-claimed at ~21:21, found no retry would follow, and was delivered anyway — a "repair ended in failed" Attention row about an account that had been healthy for 53 minutes, open until a hand clear at ~23:55.

Changes:
- `src/core/SubscriptionReloginService.ts`: new dep `onConditionCleared`; `recoveredSinceFailure(episode)` (failed/refused + `cellHealthy` + no non-terminal / in-flight episode for the same account×machine); `drainNotifications` drops a terminal notice for such an episode and reports the condition over instead; `tick` calls `reportRecoveredConditions()` (newest episode per cell, once per episode per process).
- `src/core/SubscriptionReloginRuntime.ts`: extracts the verified-health check into `cellVerifiedHealthy(accountId, machineId)` (unchanged semantics: this machine only, pool active, no identity drift, `loginCheck === 'ok'`), exposes it on the runtime, plumbs `onConditionCleared`.
- `src/core/SubscriptionReloginAttention.ts`: `clearRecoveredReloginAttention` — closes the conditionKey row and any legacy id-prefixed row for that episode through `clearAttentionCondition`.
- `src/commands/server.ts`: wires `onConditionCleared` to the adapter; the hourly-pass resolver's `localCellHealthy` now uses `cellVerifiedHealthy` instead of `status === 'active'`.
- `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts`: one awareness sentence appended to the slow-retry bullet (content-sniffed, idempotent).

## Decision-point inventory

- `SubscriptionReloginService.drainNotifications` terminal branch — modify — a failed/refused notice is not delivered when the cell is verified healthy and no other repair for it is live.
- `reportRecoveredConditions` — add — closes the condition's Attention row once per episode when verified healthy.
- Hourly-pass resolver `resolveSubscriptionReloginAttention` input `localCellHealthy` — modify — stricter (verified) health.

---

## 1. Over-block

The only "block" is suppressing a failure notice. A notice is suppressed only when the server itself verified the cell signed in (authenticated live login check + identity match + active) and no repair for that cell is still running. A refused repair on a healthy cell (e.g. an unexpected-origin hard line) is also suppressed: the account is signed in, so there is nothing for the operator to fix about sign-in; the refusal remains in the episode audit (`GET /subscription-relogin/EPISODE/events`). No legitimate "you must act" notice is suppressed: if the account signs out again, a fresh incident yields a fresh episode and its own notices.

## 2. Under-block

- A row on a machine whose server is down stays open until that server is back (the decision needs that machine's own verified read). Acceptable; nothing else can verify it.
- An account that is `active` with `loginCheck: 'unavailable'` is not treated as recovered; its row stays until expiry or a real check. Deliberate (verified, not labelled).
- Rows raised by peers for a different machine are not closed here (`cellVerifiedHealthy` is false for another machine) — each machine closes its own.

## 3. Level-of-abstraction fit

Right layer: the relogin service already owns "is this episode's condition still live" (`closeResolvedElsewhere`, `retryWillFollow`); this extends the same producer. Closing uses the existing attention-lifecycle producer path (`clearAttentionCondition` with the producer conditionKey), not a parallel mechanism. The hourly resolver stays as the backstop.

## 4. Signal vs authority compliance

- [x] No — this change has no new blocking authority over agent behavior or messages in flight from the agent; it decides whether one fixed-template infrastructure notice is still true, using the server's authoritative verified health read (the same one the repair uses to declare success), not brittle text logic.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point: "verified signed in and no repair running" is an enumerable invariant over authoritative state, and it fails toward telling the operator.

## 5. Interactions

- `closeResolvedElsewhere` runs first in the tick and closes pre-drive episodes; a cancelled/resolved-elsewhere newest episode is not failed/refused, so `reportRecoveredConditions` skips it (its own terminal notice already clears the row). No double handling.
- Slow retry: a healthy cell closes the source incident, so `retryWillFollow` is false; the new branch sits before the hold branch, so a recovered failure is never held then sent.
- Stale-notice branch (episode restarted) is checked first and unchanged.
- PR 2384 (hourly pass on send-only servers) is independent; this change closes rows on the service tick, so it works with or without it.

## 6. External surfaces

User-visible: fewer false "repair failed" Attention items and Telegram posts; rows close with a plain resolution. No route, config or message-text changes beyond the CLAUDE.md awareness sentence.

## 6b. Operator-surface quality

No operator surface (no dashboard/approval/form file) — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: a sign-in cell is one account on one machine, and only that machine can verify it (its own credential store and live read). Each machine's service closes rows it raised; the pool view (`GET /attention?scope=pool`) reflects the close on the next read. No new durable state; no URLs; it removes notices rather than emitting them.

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state (the once-per-episode memory is in-process). Rollback restores the old notices.

## Conclusion

Clear to ship as Tier 1. The incident's slow-retry question was investigated and is not a bug: `repair-time-budget-exhausted` is in the retry allowlist, unattended mode is eligible, and slow retry was enabled on the Mini (it scheduled at 20:22:28); it unscheduled at 20:28:28 because the source incident closed — the account had recovered, so no retry was needed.

## Second-pass review (if required)

**Reviewer:** independent subagent (fresh context, read the diff and this artifact)
**Independent read of the artifact: concur**

Concur: nothing is hidden on a guess; newest-first ordering holds (`createdAt DESC`); a newer live episode blocks an old episode's clear; a throwing clear re-queues the notice; the stricter hourly check does not regress Claude accounts (they report `loginCheck: 'ok'`). One minor, non-blocking note — the once-per-episode record was kept even when a held notice was later delivered (recovered → dipped → notice sent → recovered again would leave that row to the hourly pass). Applied: delivering a terminal notice now drops the record, with a unit test for that exact sequence.

## Evidence pointers

- Live: `GET /subscription-relogin/07a2d827-b005-4585-b9d4-8f76b123f33f/events` on the Mac Mini (events 65, 66, 68); Mini `GET /attention/lifecycle` lastSweepAt 17:46Z (pass not running — PR 2384).
- Tests: `tests/unit/subscription-relogin-recovered-condition.test.ts`, `tests/integration/subscription-relogin-recovered-attention.test.ts`, `tests/e2e/subscription-relogin-recovered-attention-alive.test.ts`, `tests/unit/PostUpdateMigrator-assistedRelogin.test.ts` (+3 assertions).

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: n/a` — reason: the change adds no new self-triggered emit; it SUPPRESSES one notice and performs one silent row close per failed/refused episode per process (bounded by the episode list, ≤500, and an in-process set), never a restart/spawn/notify/retry.
