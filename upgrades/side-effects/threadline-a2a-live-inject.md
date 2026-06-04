# Side-Effects Review — Threadline A2A live-inject (keep resume entry when session alive)

**Version / slug:** `threadline-a2a-live-inject`
**Date:** `2026-06-04`
**Author:** `Echo (instar dev agent)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

`ThreadResumeMap.get()` is the lookup `ThreadlineRouter.handleInboundMessage` uses to decide whether an inbound A2A message injects into a live session, resumes with history, or cold-spawns. Its resume guard nulled the entire entry whenever the session JSONL transcript was absent (`!jsonlExists(uuid)`), for any non-topic-bound, non-pinned thread. Because relay/pipe-spawned A2A sessions never get their placeholder uuid upgraded to a real transcript id, the guard nulled every peer-to-peer thread entry — discarding the still-valid live `sessionName` along with the placeholder uuid — so every follow-up cold-spawned a memoryless session (the production continuity break proven by the live Echo↔Dawn round-trip: 2 Spawned / 0 Resumed). The fix has two parts. **(1)** `get()` adds one branch: when the transcript is absent, return the entry anyway IF its tmux session is currently alive (new protected `sessionAlive()`, exact-match `tmux has-session -t =name`), so the existing `tryInjectIntoLiveSession`/`resumeThread` path can deliver into / resume the running session. **(2)** Part 1 was a no-op without the real session name: `spawnNewThread` persisted `spawnResult.tmuxSession` as the entry's `sessionName`, but the `spawnSession` callback returned only the bare instar session id, so `tmuxSession` was always undefined and a useless fallback name (`thread-<id8>`) was stored — which `sessionAlive()` and `onSessionComplete`'s `getBySessionName` could never match. The `spawnSession` callback contract now returns `string | { sessionId, tmuxSession }`; `SpawnRequestManager.evaluate` normalizes both forms and forwards `tmuxSession`; the relay spawn impl returns the real `session.tmuxSession`. Files: `src/threadline/ThreadResumeMap.ts`, `src/messaging/SpawnRequestManager.ts`, `src/commands/server.ts`, `tests/unit/threadline/ThreadResumeMap.test.ts`, `tests/unit/threadline-fixes.test.ts`, `tests/integration/threadline-live-inject-real-tmux.test.ts`.

## Decision-point inventory

- `ThreadResumeMap.get()` resume guard (`src/threadline/ThreadResumeMap.ts`) — **modify** — when transcript absent, keep the entry if its session is alive (was: always null).
- `ThreadResumeMap.sessionAlive()` — **add** — protected tmux-liveness helper; only consulted on the transcript-absent branch.
- `SpawnRequestManager.spawnSession` callback contract (`src/messaging/SpawnRequestManager.ts`) — **modify** — return type widened to `string | { sessionId, tmuxSession }` (back-compatible); `evaluate` normalizes + forwards `tmuxSession`.
- Relay `spawnSession` impl (`src/commands/server.ts`) — **modify** — returns `{ sessionId, tmuxSession }` so the real tmux name reaches the resume entry.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None — the change only *widens* what `get()` returns; it never rejects anything it previously accepted. The healthy path (real transcript exists) short-circuits before the new branch (verified by the "does NOT consult liveness when a real JSONL exists" test), so well-formed resume entries behave exactly as before. No new rejection surface.

## 2. Under-block

**What failure modes does this still miss?**

The idle-gap case: when an A2A session has fully exited AND no real transcript was captured, `get()` still returns null → cold-spawn with no history. This is unchanged by this slice and is the next slice (capture the real transcript id / resume-with-history for dead sessions). This change does not regress it; it only fixes the live-session case. Also: a stale `sessionName` whose tmux name was recycled to an unrelated session could in principle be injected into — bounded because A2A session names are unique per spawn (`msg-spawn-<timestamp>`/thread-scoped) and the delivery layer validates the target.

## 3. Level-of-abstraction fit

The fix lives in `ThreadResumeMap.get()` — the single chokepoint every router branch consults — rather than scattering liveness checks across `handleInboundMessage`. The liveness primitive (`tmux has-session -t =name`) matches the existing idiom used at `ThreadResumeMap` line ~305 and `cli.ts`. Correct layer: the storage lookup already owns the transcript-existence guard, so it should own the "but the session is alive" exception too.

## 4. Signal vs authority compliance

Not a gate/authority change. `get()` is a lookup, not an approval surface; this does not create or relax any authority. The trust gates on the inbound path (relay trust tiers, spawn evaluation) are untouched — a thread only has a resume entry because it already passed those gates on first contact.

## 5. Interactions

- `ThreadlineRouter.handleInboundMessage` (line ~554): now reaches `tryInjectIntoLiveSession` for non-topic-bound threads with a live session. That method already fails gracefully (returns null → falls through) if the session is dead, so the race window is safe.
- `server.ts` pipe-spawn guard (`!threadResumeMap.get(...)`): now correctly skips pipe-spawn when a live session exists — desirable.
- `isTopicBoundReply` check: unaffected (originTopicId still undefined for these entries).
- 1511 threadline unit tests pass; tsc clean.

## 6. External surfaces

No new HTTP routes, no config, no migration, no template/CLAUDE.md change. Pure internal routing behavior. No user-facing surface. `sessionAlive()` shells out to `tmux has-session` only on the (rare) transcript-absent branch — bounded subprocess cost, gated behind a failed `jsonlExists`.

## 7. Rollback cost

Trivial — single-file revert of `ThreadResumeMap.get()` + the helper. No state migration, no persisted format change, no external dependency. Behavior reverts to cold-spawn (the prior, known-broken-but-safe state).

## Conclusion

Low-risk, surgical fix that activates already-built inject machinery for the dominant rapid-fire A2A case. The only behavioral change is `get()` returning an entry it previously discarded, strictly when the session is alive. No over-block, no authority surface, trivial rollback. Idle-gap continuity is explicitly out of scope (next slice).

## Second-pass review (if required)

Not required — Tier 1 (30 LOC, single file, risk floor 1).
