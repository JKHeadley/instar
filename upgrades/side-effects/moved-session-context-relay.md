# Side-Effects Review — moved session inherits prior conversation (bug #2)

**Version / slug:** `moved-session-context-relay`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

A session moved to a standby now inherits the topic's recent history from the router.
New pure helper `formatForwardedTopicContext`; `spawnSessionForTopic` gains an optional
`precomputedContext`; the owner-side resume fetches the router's
`/telegram/topics/:topicId/messages` and passes it. Best-effort; default-off for
single-machine. Closes audit #2 (moved session started with no prior context).

## Decision-point inventory

- **spawnSessionForTopic context source** — `precomputedContext` provided → use it,
  skip the local TopicMemory/JSONL sources; else → unchanged local logic. Both sides
  covered (the helper tests + the single-machine path is untouched when undefined).
- **owner-side fetch** — router URL resolvable (`_resolveRouterUrl` → lease holder peer
  URL, not self) + GET ok → format + pass; any failure → spawn without it. Best-effort.

## 1. Over-block

**What legitimate inputs does this reject?** None. The single-machine spawn path is
byte-identical when `precomputedContext` is undefined (no router). The fetch is purely
additive context; a failure falls back to today's behavior (spawn without prior
history). Nothing that worked before is rejected.

## 2. Under-block

**What does this still miss?** It fetches up to 50 recent messages (not the entire
history / no summaries) — sufficient for continuity, not a full replica. It is a
point-in-time fetch, not a shared/replicated ledger (the broader architectural fix
remains separate). It is NOT yet live-verified (the moved session can't run until the
mini's Claude is logged in — bug #12, pending the user). It does not sync userProfile
(a smaller, separate gap).

## 3. Level-of-abstraction fit

**Right layer?** Yes. The formatter is a pure module (testable, mirrors the existing
JSONL format). `precomputedContext` slots into `spawnSessionForTopic`'s existing
context-resolution as the highest-precedence source. The fetch lives in the owner-side
resume (the one place a moved session is spawned), using the same `_resolveRouterUrl` /
authToken plumbing as the outbound relay.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority. It only ADDS context to a spawned session; it gates nothing and
blocks nothing. A fetch failure is swallowed (best-effort) and the session proceeds.

## 5. Interactions

Reuses the read-only `/telegram/topics/:topicId/messages` route (no new endpoint) and
the lease-holder resolution (`_resolveRouterUrl`) shared with the outbound relay. Pairs
with the owner-side resume (#9/#11): the same path that spawns + persists + confirms a
moved session now also seeds its context. Idempotent (a fresh fetch per spawn). No
interaction with the lease or shared-state guard.

## 6. External surfaces

One cross-machine GET from the standby to the router's existing messages route
(Bearer-authed). No new route, config, or notification. The visible effect: a moved
session continues the conversation instead of resetting.

## 7. Rollback cost

Low. Remove the `precomputedContext` param + the onAccepted fetch + the helper; a moved
session reverts to starting context-less (audit #2). No schema, no state, no migration.

## Conclusion

Targeted, additive, best-effort context relay; the formatter + the precedence both
unit-tested; the single-machine path untouched; no new authority/surface; cheap revert.
Makes a moved session continue its conversation. Honestly scoped: unit-verified, live
confirmation pending the mini's Claude login.

## Second-pass review (if required)

Not required — additive best-effort context, pure formatter fully tested, single-machine
path unchanged, reversible, no authority. The live moved-session-retains-context check
is the Tier-3 gate after the user's mini login.

## Evidence pointers

- `tests/unit/ForwardedTopicContext.test.ts` — formatter over empty/multi/fallback/cap.
- `tests/unit/session-pool-activation-wiring.test.ts` — owner-side bridge spawns + fails safe.
- 51 session-pool + adapter tests green; `tsc --noEmit` clean.
- Confirmed in code: on a standby, `spawnSessionForTopic` got `topicMemory: undefined`
  and `getTopicHistory` returns `[]` → `contextContent = ''` (no prior history).
- Spec: `docs/specs/moved-session-context-relay.md` (+ `.eli16.md`).
