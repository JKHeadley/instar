# Side-Effects Review — a save no longer repeats the owner step's slow checks while the graph is not ready

**Version / slug:** `graph-owner-save-reuse`
**Date:** `2026-11-18`
**Author:** `Echo (topic 144007, Accept all round 4, part 2)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (a revert undoes it; no stored state, no migration, no new authority). 3 source files touched, 2 test files.

Live evidence. With PR 3360 installed on both machines (1.3.1890-local.a88a06f), the Chief of Staff ran Accept all on Justin's live page on 2026-11-18. The click was at about 17:00:05Z. "Accepting 1 of 20 … Creating the group…" showed at +27 s and "Accepting 2 of 20" at +42 s. At +57 s it ended with "Stopped at 2 of 20: your agent is not answering right now. 0 of 20 accepted." Replay refusals were gone: 0 M5 status-403s since 16:23Z, against 5 in the hour before. The Studio log at 16:59:48Z says `answered a read without waiting: the owner step is busy with the local history check`. Its work admission closed as impaired at 17:01:03Z. In the same minute the M5's lease pulls to the Studio failed and recovered (`fetch failed`, LAN and Tailscale), and its graph went not-ready, ready, not-ready (`graph-peer-unavailable`, `custody:graph-peer-frontier-reachable-unverified`).

Cause.
- Every Accept save (`POST /conversation-graph/suggestions/:id/start`, `POST /conversation-graph/changes`) runs `ConversationGraphDefault.ensureOwner`. That is the one-at-a-time owner lane (`serialized`); since round 3 only reads may skip it.
- When the runtime is already open and not ready, `compose()` runs `synchronizeFrontiers` (peer calls, 5 s per address), then `refreshReadiness`, then `confirmRetained`.
- `confirmRetained` calls `GraphCustodyPeerFrontier.confirmLocalAcknowledgedSource`. That calls `verifyLocalAcknowledgedSnapshot`, which reopens the source store in verify-only mode and re-hashes and fsyncs every file of every record.
- The 10 s background upkeep runs the same chain in the same lane. A save therefore waits for the upkeep pass and then repeats the whole chain itself.
- `isReady()` lasts only 60 s after a successful refresh, so with a slow peer the graph keeps dropping to not-ready.
- The page's create step then gets no answer (status 0 / 5xx) and counts a "waiting"; two in a row stop the run.

Fix:
- (a) `GraphCustodyPeerFrontier.confirmLocalAcknowledgedSource` first runs its pre-checks unchanged: `assertPositiveWrites` and `assertNoNegativeDebt`. If the held snapshot has the same source, reader and dropped-origin registry and its own `assertCurrent` still passes, it returns that snapshot. `assertCurrent` checks the durable generation, the local retained negative hash, the dropped-origin physical snapshot, writes still allowed, held imports settled and the membership hash. Any change runs the full verification as before. `retained` now also records the reader and registry it was verified against.
- (b) `compose(publication, forSave)`: `ensureOwner` passes `forSave=true`. If the previous peer sync plus readiness refresh completed under `SAVE_REFRESH_REUSE_MS` (10 s) ago, a save skips repeating those two steps. It still runs the installs and `confirmRetained`, which is now cheap when unchanged. Upkeep, the pin route and restore always refresh, and a refresh records `refreshedAt` only when both steps completed without throwing.
- (c) `ownerStepValue` is now an accessor. Leaving a step that took more than `OWNER_STEP_SLOW_MS` (2 s) logs `[conversation-graph] the owner step spent N s on <step>`, at most once a minute per step name. This is log-only.

Not changed: what a save checks before it is recorded (admission, owner identity, the change pipeline and its waits for other machines), the read path, routes, the wire format, stored state.

## Decision-point inventory

- `GraphCustodyPeerFrontier.confirmLocalAcknowledgedSource` — modify — returns the already-verified snapshot when its own currency check passes, instead of re-verifying identical history.
- `ConversationGraphDefault.compose` (save path only) — modify — reuses a peer sync + readiness refresh under 10 s old.
- `ConversationGraphDefault.ownerStepValue` — add (signal only) — log line for slow owner steps.

## 1. Over-block

No issue identified. Nothing new is refused. Fewer saves wait past the page limit.

## 2. Under-block

- A save still waits in the lane behind an upkeep pass that is in flight. That pass's peer calls can take 5 s per unreachable address. (b) removes the save's own repeat; it does not cut the upkeep pass short. (c) will show whether that remaining wait matters live.
- Each committed save bumps the durable generation, so the next not-ready pass re-verifies the history once. That is still one verification per change instead of one per save plus one per 10 s tick.
- If the M5 cannot be reached at all, saves are recorded but wait for its confirmation, and the page says "changes are not being confirmed right now". That is the correct report. The reachability itself is the Studio's load and the M5 link, not this change.

## 3. Level-of-abstraction fit

(a) is in the frontier, the owner of the retained snapshot, next to `retainedSnapshotFor`. That method already trusts the same `assertCurrent` for reads. (b) is in the composer that decides what a save runs. No new layer.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface. (c) is a log signal.

(a) and (b) reduce repeated work. The checks that gate a save are unchanged. Reuse is bounded by the snapshot's own currency check and a 10 s age, and both fall back to the full path.

## 4b. Judgment-point check

No competing-signals decision point added. The 10 s reuse window equals the upkeep interval, so a save never reuses a refresh older than the one upkeep would have made.

## 5. Interactions

- Shadowing: (a) runs the same pre-checks before reuse. A peer noted unverified, or negative debt, still makes the call refuse (test). An erasure denial changes `localRetainedNegativeHash` and forces a full re-verify.
- Races: everything runs inside the serialized lane as before. `refreshedAt` is written in that lane only.
- `retainedSnapshotFor` and `assertPrivateServing` read `retained.source` and `retained.snapshot` unchanged; the added fields are not read elsewhere.
- Member-loss planning (`assertMemberLossPlanningFresh`) calls `synchronizeFrontiers` directly and is unaffected.

## 6. External surfaces

- Other machines: fewer peer frontier calls, because a save no longer adds its own. No wire change.
- Logs: a new warn line, rate-limited to once a minute per step name.
- Operator surface: none added. The page is unchanged and should simply get answers in time.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's owner lane and its retained snapshot are process-local. Nothing replicated changes.

## 8. Rollback cost

Revert the PR and install. No state, migration or config.

## Evidence

- `tests/integration/graph-custody-peer-frontier.test.ts`: new case "reuses the retained history check while the store is unchanged and verifies again after a change". It failed on main (a new snapshot every call). Now it passes, along with the 4 existing cases.
- `tests/integration/graph-default-boot.test.ts`: new cases cover a save reusing a refresh under 10 s old, refreshing again after 10 s, upkeep always refreshing, and the slow-step log line.
- Live numbers above. After install the next live run gets (c)'s step timings.

## Second-pass review

(appended below by the reviewer)

**Reviewer:** independent second-pass reviewer subagent (Claude Opus 5.5), 2026-11-18. Read the diff and code; did not run the suite. `npx tsc --noEmit -p .` is clean.

Concur with the review.

Verified points:
- (a) is not a new trust. The snapshot's `check` (ConversationGraphReplication.ts:1226) covers writes allowed, held imports settled, same erasure fence, same source directory, same reader/registry binding, `durableGeneration`, `localRetainedNegativeHash` and the dropped-origin physical snapshot. `retainedSnapshotFor` (GraphCustodyPeerFrontier.ts:110-112) and `assertPrivateServing` (:114) already rely on that same check alone to serve reads. The pre-checks (`assertPositiveWrites`, `assertNoNegativeDebt`) still run before the reuse. `assertCurrent` also compares the membership hash with `currentMembership()`, so a membership change forces a full verify.
- What is lost: the full verification re-read and re-hashed files (`syncHistoricalFile`). `durableGeneration` only moves on writes made by this process (:1990, :2017), so files deleted, truncated or corrupted out of band no longer show up on every step. This is not a safety regression. Before the change a failed re-verify left `this.retained` unchanged (it is assigned only on success), and the old snapshot kept serving through `retainedSnapshotFor`. The only loss is the repeated `graph-local-acknowledged-snapshot-unavailable` report. Non-blocking: force a full verify once a snapshot is older than a few minutes, so disk drift is still reported.
- The reused snapshot keeps its first `acknowledgedAt` and `revision`. Both describe the verified prefix, not the time of the call, so a reused copy is correct. A new acknowledgement writes ack and delivery files, which bumps the generation and gives a new snapshot (test: `highestAcknowledgedSequence` goes to 2).
- (b) `recent` is computed in the right scope, before the `runtimeValue` branch. `installCustodyAuthority`, `installPeerFrontier`, `installTransition` and `confirmRetained` still run on every save. While the graph is not ready a save is queued (Runtime.ts:291, `noteQueuedWait('not-ready')`), not refused. Skipping the sync cannot admit a save that was refused before: `synchronizeFrontiers` (Default.ts:261) swallows every peer failure, so admission never depended on it succeeding. A peer's new negative debt can now be noticed up to 10 s later on a save. The same staleness already existed between upkeep ticks.
- Non-blocking liveness gap: `refreshedAt` is not tied to the runtime or frontier it refreshed. Member-loss and transition (Default.ts:267-269) set `runtimeValue=null` and `frontierValue=null` and call `compose` again. On the member-loss early return (`memberLossProgress`, which does no sync) a new frontier gets no baseline. A save within 10 s of the old `refreshedAt` then skips the sync and the readiness refresh on the new objects. The same skip happens when `openedCustody` is true on a save. The result is a queued save until the next upkeep (at most about 10 s), not a wrong admission. Suggested fix: set `refreshedAt=0` wherever `runtimeValue` or `frontierValue` is replaced, and treat `openedCustody` as not recent.
- (c) The accessor pair is fine: `serialized`'s assignments and its `finally` go through the setter. The tests write `ownerStepValue` and `ownerStepAt` through casts, which works with a private accessor at runtime.
- Tests: the frontier case really exercises reuse (one verify call), invalidation after a commit, and the pre-check refusal. It does not cover invalidation by an erasure or a dropped-origin change. In the boot case `sync` is spied only when `custodyAuthorityValue` is set (`if(sync)`). The fixture is a single machine, so `synchronizeFrontiers` makes no peer calls, and the case proves only that the call was skipped, not the network saving. Its readiness count of 1 after upkeep shows custody authority or `openedCustody` was in effect, so the readiness half is genuinely tested.

Author response (both non-blocking notes applied in code):
- Disk drift: a reused history result is re-verified from disk once it is older than `RETAINED_REUSE_MAX_MS` (5 min), so out-of-band file damage is still reported, at most 5 minutes late instead of every 10 s. Test: the frontier case ages the held result and asserts a second full verification with the same sequence.
- Liveness gap: `refreshedAt` is reset to 0 wherever `runtimeValue` or `frontierValue` is replaced (member loss, transition), and a save that opens custody (`openedCustody`) is never treated as recent. A save against new objects therefore always refreshes first.
