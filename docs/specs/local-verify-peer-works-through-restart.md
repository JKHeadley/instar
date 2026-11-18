---
title: "Local Verify: a helper machine keeps working while the coordinator restarts"
slug: "local-verify-peer-works-through-restart"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "docs/specs/local-verify-capacity.md"
eli16-overview: "docs/specs/local-verify-peer-works-through-restart.eli16.md"
tier: 1
topic: 145097
depends-on: "PR 3451 (SEC-113, docs/specs/local-verify-peer-result-trust.md) merged"
review-convergence: "2026-11-18T21:52:46.959Z"
review-iterations: 3
review-completed-at: "2026-11-18T21:52:46.959Z"
review-report: "docs/specs/reports/local-verify-peer-works-through-restart-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 1
contested-then-cleared: 6
---

# Local Verify: a helper machine keeps working while the coordinator restarts

## Problem (measured 2026-11-16 08:00Z to 2026-11-18 08:00Z)

The test line runs on two machines. The Studio is the coordinator and holds the Local Verify lease; the M5 is the peer. Each planned Studio restart costs the M5 work it could have done, through two code paths:

1. **No new work for the peer while the coordinator waits to restart.** `dispatchOnce()` returns early when `notePause()` is true (the `if (this.notePause() || this.verifierChangedOnDisk()) return;` lines in `src/localVerify/LocalVerifyService.ts`). The pause lasts until the Studio's own run ends and the server restarts. In the window there were 21 pause windows totalling 224 min. The M5 was idle for 164 min inside them, with 40+ changes waiting. 38 of those minutes overlap the M5's own update pauses, when it refuses work anyway (`peer-busy`).
2. **A peer run that spans a restart is thrown away.** A server takes a new lease epoch on every boot, including when the same machine takes the lease back. `FencedLease.buildAcquisition` writes `currentEpoch + 1`. `pollPeers()` abandons and cancels any attempt whose `leaseEpoch` differs (`abandonRemote(entry, 'lease-changed', { cancel: true })`), and `importRefusal()` refuses with `lease-epoch-changed`. In the window, 15 peer attempts were abandoned this way after 2.3 to 26.2 min of work each, 156 min in total.

**What this change can recover (an upper bound).** About 5 of the roughly 21 restarts changed the verifier version (journal `verifierVersion`). A result dispatched before such a restart cannot count after it, and this spec keeps that rule. Without those restarts and the M5's own pauses, about 95 min of (1) and about 115 min of (2) remain over two days, roughly **105 M5-minutes a day**. That is about 4.5 M5 runs, or **about +2 merges a day** at the measured 0.48 merges per verdict run.

This is an upper bound. Attempts where the M5 also restarted are not subtracted. The build's first measurement splits them out using the `lease-changed:*` reasons below. The throughput session's restart cadence policy (at most one planned restart per two hours, from 2026-11-18) lowers both numbers. That is operating policy, not code this spec depends on.

## Proposed design

One live-read setting, `monitoring.localVerify.peerWorksThroughRestart.enabled` (boolean), switches parts A, B and C together.

- An absent or malformed value reads `false` and gives today's behaviour exactly.
- The setting is read through the same wiring setter as `laneShards`.
- No config default is written. `ConfigDefaults` has no `monitoring.localVerify` block, and this spec does not add one to every agent's config.
- The setting is a kill switch as well as the ladder gate. With it off, `markerCurrent` ignores `adoptedEpoch`, and C.3 is not entered: every epoch mismatch abandons and cancels on the next poll exactly as today (reason `lease-changed:disabled`), including attempts already adopted. No pause-time dispatch is made and no episode exemption applies.

### A. Dispatch to an idle peer during a restart pause

When the setting is true, `dispatchOnce()` and its re-check after the awaits no longer return on `notePause()` alone. They may dispatch while paused only if all of these hold:

- `verifierChangedOnDisk()` is false. If the verifier has already changed on disk, the result would not count after the restart.
- `plannedRestartBypassesHolds()` is false. This is the `bypassHolds` flag in `restart-requested.json`, which is how a forced restart is expressed today. A forced restart means nothing new is sent.
- Every existing gate holds unchanged:
  - the lease is held;
  - the service is not `stopped`, `restoring`, `blockedBy`, `mergeHold` or `verifierHold`;
  - the peer fits and is healthy;
  - the entry is dispatchable.
- The entry is a PR verify. `kind: 'main'` is never dispatched during a pause. Main verifies stay under the main-health rules and PR 3451's peer-main rules, and 3451's arbitration markers are untouched.

The local slot is unchanged: the coordinator starts nothing of its own while paused.

### B. An attempt sent during a pause does not hold that pause's restart

The pending time of a restart request is not a stable identity. Once an install starts, the wiring switches `pendingSinceMs` to the install time, and AutoUpdater clears its detection time. The `auditPeerHolds` comment already says so. The pause itself also flips off and on while one restart stays pending: 18 of 85 Studio pauses from 11-12 to 11-18 ended and began again with no restart in between, through `otherBlockers` or the pause bound. So the identity is a **restart episode** owned by the coordinator service:

- `restartEpisode: { id: string, startedAt: number } | null` is held in memory only (a restart ends it by definition, so a stored copy would never be read). Only the coordinator mints it; a peer never does.
- A new random id is minted on the first tick that an update is pending (the update provider reports pending) or a planned restart is pending (`readPlannedRestartVerifyState(...).pending`), whichever comes first. It is cleared only on a tick where neither is pending, or by the restart.
- Attempts are stamped with it only while `notePause()` is true. A pause that flips off and on under the same pending restart keeps the same id.
- When it clears or the server stops, the service audits `restart-episode-ended { episodeId, restarted, qualifying, peerIdleMs, attemptsInFlightAtRestart, pauseDispatches }`. `qualifying` is true when at least one PR was dispatchable, the peer was healthy and not in its own pause, and the verifier did not change. This row is what the graduation criterion counts.

`RemoteMarker` gains `sentDuringPause?: string`, the restart-episode id. It is validated on read, and a malformed value drops only this field, never the marker.

`qualifyingPeerAttempts()` feeds `restartHolds()` and the list written to the peer-hold file. It excludes a marker only while `sentDuringPause` equals the current, non-null restart-episode id. A null or absent id never matches. After the episode ends without a restart (nothing pending any more), the attempt holds later restarts like any other.

**Known remaining delay:** if a pause-time attempt finishes green before the restart, it goes `complete()` → `offerMerge()`. That merge hand-off holds a restart for up to `MERGE_HANDOFF_RESTART_HOLD_MS` (10 min), as for any green run. This is kept on purpose: losing a green run's merge to a restart is the failure that hold exists for.

### C. A peer attempt survives this coordinator's own restart

C builds on PR 3451's persisted holding record (`peer-trust.json`, `holding`, decided each tick by `holdingDecision()` in `checkTrustHolding()`, which runs before `pollPeers()` in `tick()`). It adds no second record of holding. The contract C depends on, as in 3451's branch, is pinned by tests in this build against 3451 as merged:

- `holdingDecision(stored, read, self)` returns `skip` on an unreadable read, `not-held` when no one holds it, `other-holder` when the read names another machine, `reset` when this machine holds but the epoch jumped by 2 or more or went backwards (or the stored holder was another machine), and `keep` on a gap of 0 or 1.
- The holding record's epoch advances only on `keep` reads that name this machine.
- If any of this differs in the merged 3451, the build stops and this spec is revised before code. `foreignHolder` is never used as evidence: it comes from an in-memory field (`StatusReconciler.lastSeenOtherHolder`) that is null after every boot.

1. **Holding start.** 3451's holding record gains `since: number | null`.
   - **Set to the current epoch** in the first-creation branch (no stored record), inside `resetHoldingState` (every `reset`, including after another holder), and on any readable `keep` that finds `since` missing, null or not a safe integer. That last case covers records 3451 wrote before this change. Such a record therefore never vouches for an attempt dispatched before the upgrade.
   - **Unchanged** on an ordinary `keep`.
   - **Why this is safe:** epochs rise by exactly 1 per acquisition, and another machine's hold uses up at least one epoch. So `keep` (a gap of 0 or 1 on each readable tick) means no other machine held the lease between `since` and now. A missed tick across two quick restarts shows up as a gap of 2 or more, which is a `reset`. The adoption is lost, never made wrongly.
2. **One current-marker test.** A single predicate `markerCurrent(m, lease)` (`(m.adoptedEpoch ?? m.leaseEpoch) === lease.epoch`) replaces every comparison of a marker epoch with the current lease: the `pollPeers` check, `qualifyingPeerAttempts`, `remoteEpochCurrent`, and the import re-check.
   - **The one exception** is the record check in `importRefusal`. There the peer's signed `attempt.leaseEpoch` must still equal `m.leaseEpoch`, the epoch the attempt was dispatched under, which PR 3451's signature covers.
   - **Guard test:** a unit test fails on any read of a `RemoteMarker`'s `leaseEpoch` or `adoptedEpoch` in `src/localVerify/` outside `markerCurrent`, `importRefusal` and the marker builder in `dispatchOnce`. The peer accept path (`peerRun`), `diagnosisPeerAccept` and 3451's arbitration code compare other epochs and are not covered.
3. **Decision when `markerCurrent` is false**, for each result of the tick's holding read:
   - **The lease read names another machine as holder (readable):** abandon with `lease-changed:holding-broken` and cancel, at once, as today. The peer is not left running a result nobody can import. One read is enough here, unlike 3451's two-read rule for deleting state: this only cancels a run, and a stale read costs at most that run. Builders should not align the two.
   - **The read is unreadable (`skip`), no one holds the lease, or this machine holds it but `holding.epoch !== lease.epoch` (not caught up):** wait. Keep the marker, do not cancel, do not import, and audit `peer-attempt-adoption-waiting` once per attempt and epoch. The wait checks the attempt's existing `maxRunMs` bound itself (60 min from dispatch; adoption never resets `sentAt`) and abandons when it passes. That bound is the same one at which the peer cancels its own attempt (`checkPeerAttempt`), so a longer coordinator wait could never import anything.
   - **This machine holds the lease, holding is `keep` and caught up, and all of these hold:** adopt.
     - `Number.isSafeInteger(holding.since)` and `Number.isSafeInteger(m.leaseEpoch)`, and `holding.since <= m.leaseEpoch`;
     - the setting is on;
     - the entry is still queued with the same PR, head, base SHA and base ref;
     - the running `verifierVersion` and `policyHash` equal the dispatched ones;
     - `kind` is not `main`.

     To adopt: set `m.adoptedEpoch = lease.epoch`, save the queue before the next await, and audit `peer-attempt-adopted { pr, attemptId, fromEpoch, toEpoch }` once. A later restart makes the same decision against the new epoch.
   - **Anything else:** abandon and cancel, as today. The audit reason is one of `lease-changed:holding-broken`, `lease-changed:entry-moved`, `lease-changed:verifier`, `lease-changed:main` or `lease-changed:disabled`.
4. **Refund.** An abandon with reason `lease-changed:verifier` gives back the entry's `remoteAttempts`, as `peer-busy` already does. Restarts that change the verifier were spending half of a PR's two peer attempts. `holding-broken`, `entry-moved`, `main` and `disabled` are not refunded.
   - At most one refund per entry for its whole stay in the queue (`peerRefunded: true`, persisted on the entry and reset only when its head changes). A second verifier-change abandon of the same entry spends the attempt as today, so the two-attempt ceiling holds and the entry falls back to a local run.
   - The audit carries `refunds` per entry, and the existing starved signal covers an entry that never finishes.
5. **Import after adoption.** If the epoch moves again between adoption and import, the import is not counted as a peer failure. The attempt goes back to step 3.

### D. Peer side: no change

The code settles this:

- The peer cancels its own attempt only at its run bound (`maxRunMs`), when its peer role is switched off, or when it becomes the lease holder (`checkPeerAttempt`).
- `peerResult` answers whatever the coordinator's epoch is.
- An unreachable coordinator never cancels a peer run.

If the M5 itself takes the lease while the Studio is down, its own attempt is cancelled (became-lease-holder). The Studio's holding is then broken, so C abandons. That is the intended result.

### Visibility and awareness

- `GET /local-verify` shows `sentDuringPause`, `adoptedEpoch` and the current `restartEpisode`.
- The existing CLAUDE.md line `LOCAL_VERIFY_PEERS_CLAUDEMD_LINE` (`src/core/PostUpdateMigrator.ts`) says a peer record must have "the same … lease epoch". `migrateClaudeMd` gets a content-sniffed, idempotent step that rewrites it in existing agents to "the same lease epoch (or, when `monitoring.localVerify.peerWorksThroughRestart.enabled` is on, a later epoch of this machine's unbroken holding; that setting is also the off switch)". The template line in `generateClaudeMd()` changes to match. Expect a rebase against 3451, which edits neighbouring awareness text.
- The build adds an `upgrades/next/` release-notes fragment and a side-effects artifact.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Dispatch to a peer while a restart pause is pending (`dispatchOnce`) | invariant; basis: enumerable-domain; evidence: the inputs are booleans the service already computes (setting, `notePause`, `verifierChangedOnDisk`, `plannedRestartBypassesHolds`, entry kind, the existing dispatch gates). No competing signals are weighed. | Which peer gets the work is still decided by the existing fit and health judgment. |
| Whether a peer attempt holds the restart (`qualifyingPeerAttempts`) | invariant; basis: enumerable-domain; evidence: the decision is an exact equality of the marker's persisted episode id with the current non-null restart-episode id. | Null never matches, so the default is to hold, as today. |
| Adopt, wait or abandon after the epoch changed (`pollPeers`, `importRefusal`) | invariant; basis: irreversible-consequence; evidence: importing a result from a coordinator whose lease another machine held in between would merge a change on an unverified premise (parent spec "Lease moves"). The rule is a conjunction of exact equalities on persisted facts. | Unmeasurable case: an unreadable lease, a missing or invalid `holding.since`, or a not-caught-up record means wait, then abandon at `maxRunMs`. It never means adopt. |
| Refund on abandon | invariant; basis: enumerable-domain; evidence: one reason in a closed set (`lease-changed:verifier`) refunds, at most once per entry per head (a persisted flag), so total peer dispatches per entry stay at most 3 and the existing fallback to a local run is kept. | |

## Fixed limits

Fixed limits introduced: none in behaviour. Existing bounds are named and unchanged: `maxRunMs` 60 min (also the peer's own cancel point), `MERGE_HANDOFF_RESTART_HOLD_MS` 10 min, and `maxAttemptsPerEntry` 2. The 10-window count in the Maturation plan triggers a review; it does not limit what the agent does (derivation given there).

## Multi-machine posture

- `peerWorksThroughRestart.enabled`: machine-local. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec, whose queue, dispatch and peer state are lease-holder-local). Only the lease holder reads it. A holder with the setting on or off is safe either way: off is today's behaviour, and on is this spec's guarded behaviour.
- `RemoteMarker.sentDuringPause` / `adoptedEpoch`: stored in the coordinator's `queue.json` (the restart episode itself is in memory only), which is lease-holder-local under the same ratification. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17. A new coordinator on another machine starts with broken holding, so it never adopts and abandons as today.
- `holding.since`: one field on PR 3451's `peer-trust.json` holding record, which 3451 already registers as lease-holder-local with the same ratification. No new file and no new registry entry.

## Maturation plan

- **ladder:** local-verify-peer-works-through-restart
- **test-agent-live:** a throwaway coordinator and peer pair, with the setting on. It must show four cases:
  - a pause-time dispatch completes and imports;
  - a coordinator restart mid-attempt is adopted (`peer-attempt-adopted`) and imported;
  - another machine holding the lease in between abandons with `lease-changed:holding-broken`;
  - a verifier change abandons with `lease-changed:verifier` and refunds.
- **dev-agent-live:** Echo's Studio and M5. The throughput session, which owns their config, turns the setting on.
- **graduation criterion:** evidence is counted over qualifying restart episodes, the `restart-episode-ended` rows with `qualifying: true` and `restarted: true` in the Local Verify audit log (`.instar/logs/local-verify.jsonl`). After at least 10, all three must hold:
  - Peer idle minutes per qualifying episode (`peerIdleMs`) are at most 2. The baseline is 7.8 over all 21 windows. The build first recomputes the baseline on qualifying windows only and replaces this figure. The bound is about a quarter of the baseline, the size of change this spec claims.
  - `lease-changed:*` abandons other than `verifier` average at most 0.2 per qualifying episode with `attemptsInFlightAtRestart > 0`. The baseline is about 0.7; 0.2 allows the two-quick-restarts and real-lease-move cases that this spec deliberately abandons.
  - Zero adverse events. An adverse event candidate is the first failed `main` record at a head that contains the merge of a PR whose green came from an adopted import, before any green `main` record at such a head. When the failing files are unknown (records list them only for 1 to 3 failures), it still counts as a candidate. Echo checks each candidate at the review. Any candidate raises the review at once rather than at the 10th episode, and a confirmed one is an immediate revert request to the throughput session.
  - Why 10: modelling abandons as a Poisson count at the baseline 0.7 per window, zero abandons across 10 windows by chance has a probability of about 0.1% (an estimate under that model). Ten is also about half the 21-window baseline sample, enough to see a change of this size. Reaching 10 triggers echo's review; it does not graduate the feature automatically.
- **fleet:** after the review passes, a later PR changes the code default of the setting to `true` for agents with peers configured. An agent with no peers is unaffected, since no peers means no dispatch.
- **dark-window:** from merge until the throughput session turns the setting on for Echo. Everywhere else, until the fleet PR.
- **owner:** echo (scaling session, topic 145097). **Review date:** at the 10th qualifying window, or at once on an adverse event.

## Tests

- **Unit:**
  - the dispatch gate truth table;
  - the restart-episode lifecycle (minted when an update or planned restart becomes pending, kept while the pause flips off and on under the same pending restart, cleared when nothing is pending, coordinator only, null never matches, `restart-episode-ended` written);
  - `qualifyingPeerAttempts` with a pause-time attempt under the same episode, after the episode ends, and under a later episode;
  - with the setting off: an adopted marker and a waiting marker both abandon with `lease-changed:disabled`;
  - `holding.since` set on first creation, on reset, and on a keep with it missing, null or invalid, and kept on an ordinary keep;
  - the adoption decision for each case in C.3 (another holder, skip, no holder, not caught up, keep with `since` before and after `m.leaseEpoch`, entry moved, verifier changed, main, setting off);
  - no re-adoption on later polls;
  - a refund only on `lease-changed:verifier`;
  - a malformed marker field dropped alone;
  - the raw-`leaseEpoch` guard test;
  - a waiting attempt still blocks dispatch to its peer and does not hold restarts.
- **Integration:** `GET /local-verify` shows the new fields; the live setter changes behaviour without a restart; the `migrateClaudeMd` step is idempotent.
- **E2E lifecycle:** a coordinator built on the production path (as in `server.ts`) with a fake peer, where a restart mid-attempt ends in import, and the first tick after boot (lease not yet held) does not cancel. A wiring test checks that the setting setter and the holding record are wired, not no-ops.

## Risks

- **Split brain:** guarded by PR 3451's holding record and `FencedLease` epoch contiguity. It does not use the in-memory `foreignHolder`. With two machines there is a second guard: the only other possible holder is the peer itself, and a peer that takes the lease cancels its own attempt (`became-lease-holder`), so nothing is left to import. That guard does not cover a third machine. Leftover foundation risk, not introduced here: a lease store without compare-and-swap could let two machines write the same epoch. That store backs every lease-holder decision in Local Verify, so it belongs to the lease layer (MULTI-MACHINE-LEASE-ROBUSTNESS, Problem A), not to this spec. Even in that case, adoption needs the peer's record signed for this coordinator's dispatch (PR 3451) and every equality in C.3.
- **Restart delayed:** pause-time attempts do not hold the restart of their own restart episode, even when the pause flips off and on under it. A green merge hand-off still holds for up to 10 min (see B).
- **Version change in the update:** the attempt is abandoned with `lease-changed:verifier` and refunded. That is no worse than leaving the peer idle.
- **Two restarts close together** (4 seen within 81 to 97 s, 11-15 to 11-18): if no tick ran in between, holding resets and the adoption is lost. That is safe, and it is counted under `holding-broken`.
- **Rollback:** older code reading an adopted marker abandons it with `lease-changed`, which is safe. Turning the setting off stops A and C.
- **Hung versus slow:** not addressed. An adopted run still ends at the fixed 60 min counted from dispatch, as every peer run does today.
- **Ordering:** the build starts only after PR 3451 is merged, pinned to 3451's holding rules as merged. It is rebased onto PR 3141 (adopting a live local run after restart) if 3141 merges first. The first-tick-after-boot test runs against whichever boot order is on main.

## Parent spec change

This spec amends the "Lease moves" clause of `docs/specs/local-verify-capacity.md`. That clause says a coordinator that regained the lease at a new epoch imports nothing from earlier dispatches. After this spec, with the setting on, the coordinator imports a result from an earlier epoch only when the dispatch was made inside the same unbroken holding (C.3). A different holder in between still means nothing is imported. The same PR adds an amendment note under that clause.

## Frontloaded Decisions

1. A, B and C ship dark behind one setting and climb the maturation ladder above. The throughput session turns it on for the dev-agent rung. Cheap-to-change-after: it is a live-read boolean and a kill switch, and its only durable effect is markers that end with their attempt.
2. The build run starts when PR 3451 is merged. Until then nothing is built, so the builder never stops halfway.
3. The graduation criterion's numbers trigger echo's review, which decides keep or revert; a confirmed adverse event is the only automatic revert request. This session reports to the throughput session, which applies config.
4. No config default is written, and the fleet default changes later in code (see Maturation plan).

## Open questions

*(none)*
