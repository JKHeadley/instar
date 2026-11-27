# Side-Effects Review — an owner read is answered from the open graph instead of queuing behind the owner step; the suggestions page retries by itself

**Version / slug:** `graph-owner-reads-not-held`
**Date:** `2026-11-17`
**Author:** `Echo (topic 144007, Accept all round 3)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

After install 2 (1.3.1872-local.606adff, Studio and M5 restarted 14:54-14:55Z on 2026-11-17), Justin's Suggested efforts page showed "Loading suggestions…", then "Your agent did not answer in time. Try again." for about 30 minutes (look-only checks 15:13Z and 15:22Z). It recovered on its own at 15:25:55Z, when suggestions loaded in 1.9 s.

What was measured on the live Studio:
- `GET /conversation-graph/suggestions` is synchronous. The only await before it is the surface middleware's `await manager.ensureOwner(...)`, so the whole 20 s went into the owner step.
- `ensureOwner` runs in `ConversationGraphDefault.serialized()`, one request at a time. The same queue carries the 10 s background tick (`distribute` + `compose`). `compose` awaits peer frontier checks on every member and, while the runtime is not ready, a full readiness pass under the runtime's mutation lock.
- Readiness kept lapsing after the restart. The runtime counts as ready for 60 s after a passing pass. On the lease holder, the background pass returns early whenever the tail-close to the peer fails, and the M5 kept failing. The M5's log shows it flapping between `ready` and `not ready yet, stopped at: graph-peer-unavailable` / `custody:graph-peer-frontier-reachable-unverified` until 15:28Z. The M5's server cannot reliably reach the Studio: Tailscale gives `ehostunreach` from the server process (a shell on the M5 gets through in 54 ms), the home-network http address is skipped (`graph-peer-call-url-not-allowed`), and the Cloudflare tunnel gives 530/502/timeouts.
- CPU profile (inspector, 15 s and 20 s): the readiness pass was running (witness inventory exports every ~15 s in `custody.sqlite`), not deadlocked; no peer connection was open.
- `[conversation-graph] ready` was never logged after a restart, because `lastLoggedReadiness` started at `null`, which is the value "ready" maps to. That made the window look like "never ready" in the log.

Fix (Tier 1, 3 source files + 1 page file):
- `ConversationGraphDefaultSurface`: a GET whose graph is already open (the surface is mounted on the manager's current runtime) waits for `ensureOwner` at most `readOwnerWaitMs` (default 1.5 s). After that it is answered from the open runtime, and the owner step finishes in the background (its rejection is caught; it reports its own failures). It logs once per distinct busy step: `[conversation-graph] answered a read without waiting: the owner step is busy with <step>`. Writes (any non-GET), and any request before the graph has opened, wait exactly as before.
- `ConversationGraphDefault`: `ownerStep` getter. The serialized section labels what it is doing ("background upkeep", "finding the shared graph", "sharing pins", "opening the graph", "checking the other machines", "the readiness check", "the local history check"), and the label returns to "nothing (idle)" when each task ends. This is evidence for the next slow restart.
- `ConversationGraphReplicationRuntime`: `lastLoggedReadiness` starts `undefined`, so the first "ready" after a restart is logged.
- `dashboard/console/conversation-suggestions.js`: a timeout or `503` says "Your agent is still getting your conversations ready. This can take a few minutes after it restarts. Trying again by itself in 15 seconds." and retries by itself every 15 s for 5 minutes by the clock. After that it says so and keeps the Try again button. Joining machines (`awaitingJoin`) keep the existing wording without auto-retry. Other failures say "Nothing is lost. Tap Try again."
- Same file: a finished card drops its Accept/Reject buttons and keeps its result words and its Open project link. On the real two-machine run, the page said "All 4 projects accepted." while the first card still showed Accept and Reject (disabled, but they looked tappable).

## Decision-point inventory

- Owner read wait — modify — awaited without bound → bounded wait, then served from the already-open runtime (GET only, after first open).
- Page retry — add — fixed 15 s cadence for 5 minutes by the clock.

## 1. Over-block

None added. Fewer requests fail: a read that used to time out now answers.

## 2. Under-block

A read served without waiting skips this request's `ensureOwner` side effects (pin re-share, frontier refresh, readiness pass). They still run on the background tick and for the next request, and the owner check (`resolveViewer` + `isCurrent`) still runs on every request before and after. A read cannot answer from a runtime other than the manager's current one: the fast path requires `options.manager.runtime === mountedRuntime`. Before the first open there is no mounted surface, so the first visit after a restart still waits (and gets a 503 with plain words and an automatic retry if the open fails).

The M5 → Studio reachability fault (Tailscale `ehostunreach` from the server process) is not fixed here. It is a separate network defect, triaged to the feedback queue. It slows the M5's readiness; with this change it no longer blocks the Studio's page.

## 3. Level-of-abstraction fit

The wait is bounded at the HTTP surface, which is the only place that knows whether a request is a read and whether a runtime is already mounted. The manager keeps its one-at-a-time semantics; nothing in custody or replication changes.

## 4. Signal vs authority compliance

- [x] No new authority. The change only stops a read from waiting; it grants nothing. The step label is a log signal.

## 4b. Judgment-point check

No heuristic. Fixed bounds: 1.5 s owner wait, 15 s page retry, 5 minutes of automatic retries.

## 5. Interactions

- Round 2's background pin re-share (`repinInFlight`) and read-view cache are unchanged; the read path now reaches the cache without queuing.
- `ConversationGraphMemberLossSurface` GET routes use the same path. They read through the manager, and their writes are POSTs, which still wait.
- The `serialized()` wrapper now resets the label in a `finally`; ordering, error propagation and `this.chain` are unchanged (the task still rejects with the work's error).
- Graph default integration tests: `graph-default-boot` (7, including the new busy-owner test), `graph-default-peers`, `graph-default-nonmember-paired`, `conversation-graph-default-local-capability`, and the console DOM tests (35).

## 6. External surfaces

No route, wire or file format change. New log lines: `answered a read without waiting: …` (once per distinct step) and `ready` after a restart.

## 6b. Operator-surface quality

The "Try again" dead end after a restart becomes plain words that say what is happening and what happens next, with the page retrying by itself. Nothing for the owner to do.

## 7. Multi-machine posture

Machine-local by design: each machine's HTTP surface decides how long its own reads wait for its own owner step. Replication, custody and leases are unchanged.

## 8. Rollback cost

Pure code change: revert and ship a patch. No migration, no stored state.

## Conclusion

A Conversations read no longer queues behind the graph's slow start-up upkeep. Writes keep their full checks. The next slow start-up leaves a log line naming the step.

## Second-pass review

**Reviewer:** independent reviewer subagent (fresh context; read the diff and the surrounding owner, member-loss, history and suggestion routes).
**Verdict on the first version: concern; authorization holds** (`resolveViewer`/`isCurrent` before and after; `assertOwner` runs synchronously in `ensureOwner`, so a wrong or revoked owner rejects before the timer; no GET needs this request's `ensureOwner` side effects). Findings and what was done:
1. Real: the runtime-current check ran only on entry, so an activation or member-loss swap inside the 1.5 s wait could answer from (and remount) a closed runtime. Fixed: after the wait, the read is answered from the open graph only if it is still both the manager's runtime and the mounted one; otherwise it waits as before. Test added (runtime replaced during the wait → the read waits).
2. Low: jobs that do not set a label logged "busy with nothing (idle)". Fixed: every serialized task starts as "other owner work".
3. Low: "after 5 minutes of trying" could mean about 12 minutes (20 tries × (15 s + up to 20 s)). Fixed: the limit is 5 minutes by the clock.
4. Test gaps: Try again while an automatic retry is pending (now tested: one load, not two); runtime swap (now tested).
**Second round: concur.** One low note kept as is: `afterActivation` / `installCompletedMemberLoss` await `previous.close()` before clearing `runtimeValue`, so a read whose wait ends inside that close can be answered from a runtime that is shutting down. It gets an error or 503 (never wrong data), and the page now retries that by itself. Requests already in flight had the same exposure before. Also noted: a card finished as "already inside another project" never had an Open project link; it keeps its words only.

## Evidence pointers

- `tests/integration/graph-default-boot.test.ts` — "answers an owner read from the open graph while the one-at-a-time owner step is busy; a write still waits for it".
- `tests/unit/console-conversations-dom.test.ts` — "a graph that is not open yet (after a restart) says what is happening and tries again by itself", "tapping Try again while an automatic retry is pending loads once, not twice", "suggestionsUnavailable: …", and the Accept all completion test now checks finished cards have no Accept/Reject.
- Real two-machine throwaway (Studio + M5, 2026-11-17 16:06-16:12Z): both restarted on this build, M5 frozen; reads answered in ~1.5 s with plain words and automatic retry (log: `answered a read without waiting: the owner step is busy with the readiness check`); M5 resumed → suggestions shown by the page itself ~40 s later; real Accept all → "All 4 projects accepted." in 100 s.
- Live evidence (2026-11-17): look-only page logs at 15:13Z and 15:22Z (20 s abort), CPU profiles of pid 13026, M5 `logs/server.log` 14:55-15:28Z, page recovered 15:25:55Z (suggestions 1.9 s at 1280 and 390).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a coupling defect between owner reads and graph upkeep, closed by the tests above).
