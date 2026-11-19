# Side-Effects Review — a save waits for the owner step at most 3 s; the background history check is spaced out

**Version / slug:** `graph-save-lane-wait`
**Date:** `2026-11-19`
**Author:** `Echo (topic 144007, Accept all round 4, part 4)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: 2 source files, 1 test file. A revert undoes it; there is no state or migration.

Live evidence. On 1.3.1906-local.2ca3c24 (PRs 3360, 3448 and 3476), Accept all again stopped at "Stopped at 2 of 14: your agent is not answering right now" (03:32-03:44Z). The Studio log for that window shows:
- `the local history check took 117.8 / 74.4 / 70.4 / 112.3 s (outside the owner step)`, restarted again and again.
- `the owner step spent 11.5 / 25.4 / 28.7 / 51.2 s on the readiness check`, growing over the run.

Cause:
- Since part 3 the history check runs outside the lane. But every save changes the store, so the next 10 s upkeep tick re-ran the full re-read. That kept the overloaded Studio's disk and CPU busy almost all the time.
- Saves still waited in the lane behind upkeep's readiness pass (peer round trips to the M5). That pass grew to 51 s, past the page's 20 s request limit.

Fix:
- (a) `ConversationGraphDefaultSurface.ownerRuntime`: a save (non-GET) on an already open, mounted, current graph waits for `ensureOwner` at most `writeOwnerWaitMs` (3 s). After that it runs on the open graph, exactly as reads have since round 3 (1.5 s). The owner step still finishes in the background. Before the graph is open, or if the runtime was replaced meanwhile, a save waits as before. The log line now names saves too: `answered a save without waiting: the owner step is busy with <step>`.
- (b) `ConversationGraphDefault.startRetainedCheck`: on the same runtime, at most one start per `RETAINED_CHECK_MIN_GAP_MS` (5 min). A new runtime starts at once.

## Decision-point inventory

- `ownerRuntime` (save path) — modify — bounded wait instead of an unbounded one. Admission checks are unchanged.
- `startRetainedCheck` — modify — spacing between starts.

## 1. Over-block

None.

## 2. Under-block

- What ensureOwner does that a save no longer waits for:
  - `assertOwner`: principal, request id, method, `isCurrent()`. The router already resolved the owner and checks `isCurrent()` both before and after `ownerRuntime`.
  - `distribute`/`compose`: pins, frontier sync, readiness. These are upkeep. A save while not ready is recorded and waits for confirmation in the runtime's own pipeline.
  - So no admission is skipped.
- Each skipped wait still leaves that save's `ensureOwner` queued in the lane. A burst of saves during a long upkeep pass adds short queued steps behind it. With 3448 those reuse a refresh under 10 s old, so they are cheap.
- The older-copy read view refreshes at most every 5 minutes while saves keep flowing. Once the graph is ready, it is not needed.
- A check that fails (transiently) is also retried only after 5 minutes on the same runtime, so the older-copy view can stay unavailable up to 5 minutes after one failure. It is reported as `graph-local-acknowledged-snapshot-unavailable` and is a read-side view only.

## 3. Level-of-abstraction fit

Same seam as round 3's read change. Same check as part 3.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface. Admission and ownership checks are unchanged.

## 5. Interactions

- A save now runs while upkeep is in the lane. The mounted surface's change handlers serialize source mutations themselves (`withSourceMutation`), and the runtime already serves peer requests concurrently with the lane. Reads have run this way since round 3.
- A runtime replaced while a save waited: the save goes back to waiting for `ensureOwner` (the same guard as reads).

## 6. External surfaces

Logs only: the read/save wording. No route, wire or state change.

## 7. Multi-machine posture

Machine-local by design.

## 8. Rollback cost

Revert and install.

## Evidence

- `tests/integration/graph-default-boot.test.ts`:
  - Round 3 case: a save made while the owner step is held is still waiting at 0.8 s and commits (200, `committed`) within 10 s while the step is still held. The "answered a save without waiting" line is logged.
  - Part 3 case: no second history check within 5 minutes; another one once 5 minutes have passed.
- Related files: graph-default-boot, graph-custody-peer-frontier, graph-default-peers, conversation-graph-local-acknowledged-snapshot, conversation-graph-owner-changes (see PR).

## Second-pass review

(appended below by the reviewer)

**Reviewer:** independent second-pass reviewer subagent (claude-opus-5-5), 2026-11-18.

Concur with the review. Verified points:
1. Admission. `assertOwner` (ConversationGraphDefault.ts:177) checks principal `owner:<agentId>`, an opaque request id, the auth method and `isCurrent()`. The router (ConversationGraphDefaultSurface.ts router.use) resolves the viewer (conversationGraphViewer.ts:14-27 always yields `owner:<agentId>`), supplies a random UUID and the matching method, and checks `isCurrent()` before and after `ownerRuntime`. So nothing is skipped. The mounted surface has its own owner admission (ConversationGraphSurface.ts:113). The member-loss service has its own grants and owner checks (ConversationGraphMemberLossSurface.ts:57-63). `nativeForOwner`, grant handling (`this.grants`, `admit`) and `createPublication` only matter before a publication or runtime exists. The early path is taken only when the runtime is mounted, open and current, so they never arise there.
2. inheritLiveOwnerIntents / enrolled spool. The provisional spool is filled only when `ensureOwner` throws (catch branch of router.use). The inheritance runs in every `compose` on an existing runtime (ConversationGraphDefault.ts:252), including the 10 s upkeep tick (:391). A save that skips one inheritance is not left out of a later one. Before this change, an open-graph save whose `ensureOwner` threw (distribute or readiness errors) fell into `provisional` as a 202 `recorded-local`. Now it commits on the open graph, which is the better result.
3. Concurrency. The lane never gave a handler mutual exclusion. `ensureOwner` returns the runtime, and the handler then runs OUTSIDE `serialized`, so the next upkeep `compose` could already overlap any save, member-loss POST or forget. The new part is that a handler can now start in the middle of a `compose`. Runtime replacement is guarded: in the new-runtime branch (:256), `runtimeValue` is set before the listeners call `mount`, so `manager.runtime!==mountedRuntime` sends the request back to waiting. The early answer happens only once inherit, custody authority, frontier and transition are installed; only frontier sync and readiness may still be pending, which is the not-ready state the runtime already handles. Two saves are serialized by the runtime (`withMutation` / `withSourceMutation`, ConversationGraphReplicationRuntime.ts:237,653), not by the lane. `installCompletedMemberLoss` and the transition install (:283,:285) take the lane themselves.
4. Routes. Every non-GET under `CONVERSATION_GRAPH_PATH` (ConversationGraphSurface.ts:37) now goes through the early path: changes, forget, decisions, mobile variants, cancel, and member-loss prepare/confirm/cancel (ROUTE, MemberLossSurface.ts:22). Member-loss planning re-checks freshness itself (`assertMemberLossPlanningFresh` runs `synchronizeFrontiers` inline, :263), and its install is lane-serialized. So a positive allowlist would add no safety the lane ever provided. I do not require one.
5. Retained-check spacing. `retainedCheckRuntime` is no longer cleared on finish. That is correct: the in-flight guard keys on `retainedCheck` (now null) plus the runtime, and a replaced runtime still starts at once. A side effect the artifact does not state: a FAILED check (`confirmRetained` catch) is now also retried only after 5 min, not on the next tick. The older-copy view can stay unavailable for up to 5 min after one transient failure. That is acceptable (signal only, reported as `graph-local-acknowledged-snapshot-unavailable`); worth one line under Under-block.
6. Tests. The round-3 case awaits the save BEFORE `release()`, so it really proves the save commits while the step is still held, and it checks the new log line. The part-3 case: the same compose call that used to start a second check now leaves the count at 1, and it reaches 2 only after the start time is moved back past 5 min. That proves the gap. Neither test checks the lower bound (that a save waits about 3 s), only that it has not finished at 0.8 s; that is adequate.
7. `npx tsc --noEmit -p .` is clean. The artifact is accurate apart from point 5; its Date (2026-11-19) is a day ahead of this review.

Author response: point 5 added under Under-block. Dates are UTC (the review ran 2026-11-19 ~03:50Z, 2026-11-18 PST).
