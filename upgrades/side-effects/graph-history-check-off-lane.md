# Side-Effects Review — the local history check runs outside the owner step

**Version / slug:** `graph-history-check-off-lane`
**Date:** `2026-11-19`
**Author:** `Echo (topic 144007, Accept all round 4, part 3)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: 1 source file, 1 test file. A revert undoes it, and there is no state or migration.

Live evidence. With PR 3448 installed (1.3.1903-local.10c04fb on both machines), Accept all reached 6 of 20. After the Studio restart at 01:19Z, the relaunched run stopped at "Stopped at 2 of 14: your agent is not answering right now", 10 times in a row (01:25-01:41Z). The Studio log line added by 3448 named the cause: `[conversation-graph] the owner step spent 450.1 s on the local history check` (01:40:37Z). Then: `spent 35.5 s on the readiness check`, plus repeated `answered a read without waiting: the owner step is busy`.

Cause. PR 3448 made the history check reuse a result while the store is unchanged. After a restart, though, the first check is always a full re-read: `verifyLocalAcknowledgedSnapshot` re-hashes and fsyncs every record. On the Studio's history that takes about 7.5 minutes. It ran inside the one-at-a-time owner step (`compose`, which `ensureOwner` and upkeep both call), so every Accept all save waited behind it past the page's 20 s limit.

Fix. `ConversationGraphDefault.startRetainedCheck()` runs `confirmRetained` one at a time per runtime, in the background, outside `serialized`. Both former inline `await this.confirmRetained()` calls start it instead: the "already open" branch of `compose`, and the first open in `compose`. The check is skipped when the runtime is ready, closed, or replaced. A check over 2 s logs `[conversation-graph] the local history check took N s (outside the owner step)`. `close()` waits for it.

## Decision-point inventory

- `ConversationGraphDefault.compose` — modify — no longer waits for the history check.
- `startRetainedCheck` — add — one background check at a time; no block/allow surface.

## 1. Over-block

None. Nothing new is refused.

## 2. Under-block

- What the check feeds (the retained "older copy" view: `retainedProjection`, `assertPrivateServing` and header custody, only while the graph is not ready and was never ready since start) is now available only once the background check finishes. A save that needs it during that window fails fast instead of waiting minutes. Before the change the page waited up to 450 s and then gave up anyway. Saves that do not need it, and every save once the graph is ready, go straight through.
- A save that lands while the check is reading makes the check refuse its result (`graph-local-snapshot-state-changed`, the existing guard). The next pass starts it again. Under constant writes it may finish late; saves do not wait on it.

## 3. Level-of-abstraction fit

Same composer, same check. Only where it runs changes. The check's own currency guard (durable generation, erasures, dropped origins) is what makes running it outside the lane safe.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 5. Interactions

- Races: the check holds no lane. A store change while it runs makes it throw `state-changed` and keep no result (the existing guard). `retained` is assigned only on success, in one synchronous step.
- Replaced runtime: `confirmRetained(runtime)` returns at once if the runtime is no longer current.
- Close: `close()` waits for an in-flight check before closing the stores.
- PR 3448's reuse still applies inside the check.

## 6. External surfaces

Logs only: one new line for a slow check. Nothing changes on the wire, in routes or in stored state.

## 7. Multi-machine posture

Machine-local by design. The check reads this machine's own store.

## 8. Rollback cost

Revert and install.

## Evidence

- `tests/integration/graph-default-boot.test.ts` adds "runs the local history check outside the owner step, one at a time, so a save is not held behind it". With the check held open, an upkeep pass returns at once and the owner admission for a save (`ensureOwner`) resolves. A second pass does not start a second check. After the check finishes, the next pass starts a new one.
- Related files pass: graph-default-boot, graph-custody-peer-frontier, graph-default-peers, conversation-graph-local-acknowledged-snapshot (see PR).

## Second-pass review

(appended below by the reviewer)

**Reviewer:** independent second-pass reviewer subagent (Claude Opus 5.5), 2026-11-18.

Concur with the review. One minor, non-blocking note below.

Verified points:
- Concurrency: `verifyLocalAcknowledgedSnapshot` (src/core/ConversationGraphReplication.ts:1206) only reads on the live instance. `syncHistoricalFile` (:1339) opens O_RDONLY and fsyncs the fd; it writes nothing. Every live `save()` (:1985) bumps `durableGeneration`, except `.emitted.json` bookkeeping, and so does `removeBundle`. The per-record generation/negative check, the final `check()` and `assertHeldImportsSettled` therefore refuse a result if anything changed while it read. A rename under a read fails `graph-history-import-file-changed` (fails closed). Source writes from the runtime (imports, peer sync) never ran in the manager lane, so the check was already concurrent with them. Only lane-originated work is new overlap.
- The verify-only reopen can still `store.save(...'erasure')` at :518 in any mode. That write predates this change, happens on a separate instance, and is atomic (temp+rename). It is not a new risk.
- `retained` is assigned only after a successful `assertCurrent` (GraphCustodyPeerFrontier.ts:109-111), in one synchronous step.
- Writes in the window fail fast and never admit wrongly. `retainedProjection` throws `graph-runtime-retained-unavailable` when `lastVerifiedAt===0` and nothing is retained (ConversationGraphReplicationRuntime.ts:526). `privateCustodyAllowed` returns false (:268). `readiness().retained` honestly reads false. A stale old-runtime snapshot is rejected by the `membershipHash` and source identity checks in `assertCurrent` (:237). No path proceeds on missing or stale data.
- Ordering: nothing between `startRetainedCheck()` and `runtime.start()`/`this.start()` reads `retained`. If the initial sync writes during the check, the check refuses its result and the next 10 s tick restarts it. That costs time, not correctness; artifact section 2 covers it.
- close(): `startRetainedCheck` refuses after `closed`. A compose still queued in `chain` cannot start one late. `confirmRetained` catches everything and `.finally` does not rethrow, so there is no unhandled rejection. close() can still wait out an in-flight check, as before, when the check sat inside `tickWork`/`chain`.
- `npx tsc --noEmit -p .` is clean.

Minor note (not blocking): single-flight is not keyed by runtime. After `afterActivation` or `installCompletedMemberLoss` swaps the runtime (ConversationGraphDefault.ts:274-276), a check still running on the old runtime keeps `retainedCheck` set. Its `runtime!==this.runtimeValue` guard runs only at entry. So the new runtime's compose skips its own check until the old full re-read ends, which can take minutes. Safe, but it delays the retained view after a transition. Possible fix: store the runtime next to `retainedCheck` and start a new check when they differ, or track this as a follow-up.

Test (graph-default-boot.test.ts:112): the test does show that compose in the lane returns while the check is held, that `ensureOwner` resolves, that a second pass starts no second check, and that a new check starts after release. Nit: it proves `ensureOwner` resolves, not that a save is written. The artifact's "a save resolves" should read "the owner admission (`ensureOwner`) resolves". The first-open call site has no held-check assertion of its own.

Artifact accuracy: sections 2 and 5 match the code. The claim that "every save once the graph is ready" goes straight through is correct, because `startRetainedCheck`/`confirmRetained` return at once when `isReady()`.

Author response: both notes applied. Single-flight is now keyed by runtime (`retainedCheckRuntime`): a check still reading for a replaced runtime no longer holds back the new runtime's check, and `close()` waits for every check still running (`retainedChecks`). The test wording now says the owner admission (`ensureOwner`) resolves. One related test changed: `graph-default-peers` "serves actual acknowledged private memory as retained … at cold restart" sent a single read the instant the graph opened; that read used to wait inside the owner step for the full check and now gets `conversation-graph-pending` until the background check finishes. Its helper (`tests/helpers/graph-owned-cold-read.mjs`) now asks again for at most 30 s when the test opts in (`retryPending`), as the Conversations page does. The assertions (200, the private title served, `current:false`, `retained:true`) are unchanged. The withholding test that shares the helper does not opt in.
