# Side-Effects Review — The shadow fold runner (context budget Phase 2 slice P2-4b)

**Version / slug:** `cb-p2-shadow-runner`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** independent subagent (see the end of this file)
**Spec:** `docs/specs/context-budget-layered-summaries.md` (v9, converged, approved) §16 step 3, §7.1–§7.5, §9.3 (step 0 Prepare, fencing, pool-live owner), §10 (shadow mode)
**Stacked on:** P2-4a (#3563) → #3561 → #3555 → #3551 → #3543; also cherry-picks P2-5 (#3559)

## Summary of the change

This is the piece that runs a shadow fold. On a development agent it is live behind `contextBudget.fold.shadow` (dev-gated, read on every trigger). On the fleet it is dark.

1. **`src/monitoring/foldShadowRunner.ts` — `runShadowFoldOnStop`.** On a topic session's turn end, in order:
   - **Brakes and estimate:** brakes (2 asks/hour, 30-minute backoff, 1 in 3 clean stops), then the §7.2 benefit estimate (unknown or below the margin means skip).
   - **Clean stop:** the §7.3 check (any unknown means skip).
   - **Prepare:** a `prepared` fold record (the coordinator's preconditions: owner, sentinel heartbeat, live inbound queue, rows). Then the fold hold, the live session's marker and the inbound hold, each before the next; any failure aborts.
   - **Handoff turn:** the internal handoff request is injected. The reply is read within a 5-minute bound, with the lock renewed and the marker re-stamped while waiting, and the lock window recorded. It is parsed, verified and audited, with send-back, demote or decline per policy.
   - **Release:** the live session is released at once (hold, ITS marker, inbound), and the record moves `prepared → shadow-probing`.
   - **Probe:** the packet is built, verified and staged, probe material is selected, questions generated, the throwaway answerer run, answers graded and rolled up.
   - **Record and close:** one row in the shadow-fold record, then `shadow-probing → aborted` with reason `shadow-graded`. Settle releases the staged packet and the answerer's marker.

   Every exit writes exactly one row and leaves the record terminal. The live context is never replaced (`contextBudget.fold.enabled` is never read).
2. **`src/monitoring/foldShadowRunnerBoot.ts` — `startShadowFoldRunner`.**
   - **Trigger:** the `Stop` hook event, with deliberately no timer sweep (an idle minute is not a clean stop).
   - **Concurrency:** one shadow fold per machine at a time; a second turn end is ignored, never queued.
   - **Handoff reply:** the handoff turn's own `Stop` is routed to the waiting runner and never starts a second fold.
   - **Sessions:** only Claude Code sessions on positive Telegram topics.
   - **Real dependencies:** the transcript tail (bounded to 4 MB), the token ledger (live context, lag, trailing turn rate) and the §7.2 estimate.
3. **`src/monitoring/foldWiringHelpers.ts`:**
   - `foldedSpansFromArchive`: a stretch's entries from the transcript archive, via every known message id inside the stretch, bounded.
   - `ledgerInputs`: the Anchor text, the live ledger items, and the settled decisions for the deterministic dropped-decision trigger.
4. **Pool-live fold ownership (§9.3), in `foldCoordinatorBoot`.**
   - With placement live, the owner is the host AND the machine the topic's ACTIVE ownership record names. A missing record or mesh identity is unknown (`owner-unknown`); placing, transferring or released is not ownable.
   - `ownerEpoch` is the record's epoch, so an ownership change fences every later transition.
   - Before this, every topic on a pool-live agent such as Echo read `unknown`, so no fold could ever begin there.
   - `server.ts` passes the registry and mesh id through call-time closures that read `unknown` if the registry is not built yet (boot order).
5. **`server.ts`** starts the runner after the `AgentServer` is constructed, which makes the token ledger reachable through a new read-only `AgentServer.getTokenLedger()`. It wires every dependency from the live objects: holds, inbound store, session manager, subagent tracker, commitments, TopicMemory, layer store and archive, shared intelligence, memory privacy for the probe token, and transcript lookup.

**Files.** New: `foldShadowRunner.ts`, `foldShadowRunnerBoot.ts`, `foldWiringHelpers.ts`; tests `fold-shadow-runner` (9), `fold-shadow-runner-boot` (4), `fold-pool-ownership` (11), e2e `context-budget-fold-shadow-alive` (2). Modified: `foldCoordinatorBoot.ts`, `server.ts`, `AgentServer.ts` (one getter). The cherry-picked P2-5 commit (`foldBenefit.ts`) is unchanged.

**Size and effort.** Tier 2, high-risk surface (it injects into live sessions and holds inbound). About 420 LOC of source. The integration points were mapped first by a research subagent. Fixes during the build:
- a sweep I had planned was removed: it counted idle minutes as stops;
- engine-name literals were replaced with the shared constant;
- two fixture corrections in my own e2e test.

## Decision-point inventory

- **Whether to ask a live session for a handoff** (add). Brakes, then the benefit estimate, then the clean stop: deterministic inputs designed in P2-4a and P2-5.
- **Fold ownership with placement live** (modify). From "never" to the §9.3 rule.
- **What the handoff ends as** (add). The audit policy: accept, send-back, demote or decline.

## 1. Over-block

The fold hold refuses the live session's outbound sends, and inbound is held, during the handoff turn only. That is bounded by the 5-minute handoff bound, and the hold expires at 3× the bound. A real operator message arriving in that window waits in the inbound queue (held, not lost) and is delivered when the turn ends and the hold is released. Every exit releases them. A step that throws after `begin` is caught and closed as `step-threw`, so the record and holds can never be left open to mute the conversation until a restart.

## 2. Under-block

- **Artifact signals come only from open commitments** naming a finished stretch's artifact. PR and test state are not yet read: no PR-state source is reachable in-process. The audit model and `droppedDecisions` still apply. An uncontested-but-unfinished stretch is caught by the probe, not the signal check.
- **Open threads are 0 in the estimate.** H1 has no open-thread list today. Expected turns come from the trailing rate alone, which is conservative: fewer asks.
- **Lock-window consumers.** The window is recorded and durable (P2-4a). The handoff turn's text is not sent to Telegram, because the fold hold refuses the send, so TopicMemory does not ingest it. The transcript-growth ticker may still read the turn once as tool awareness. That affects H1 freshness only, never a protected layer.

## 3. Level-of-abstraction fit

The runner composes the slice modules; the boot module owns triggers and concurrency; `server.ts` only passes live objects. Ownership lives in the coordinator boot, where the other preconditions are.

## 4. Signal vs authority compliance

The runner acts only through the coordinator's existing authority: the record's compare-and-swap transitions, the fold hold and the inbound hold, all built and reviewed in Phase 0. Its decisions are the deterministic inputs from P2-4a and P2-5. Nothing here replaces context or blocks anything outside the bounded handoff window.

## 5. Interactions

- **Inbound queue:** `holdForFold` / `releaseFold` on the same store the boot sweep and drain use. On Echo it is live (`enabled`, `dryRun:false`).
- **Fold hold:** the same `_foldHolds` instance the outbound chokepoints read.
- **Sentinel:** `begin()` refuses without its heartbeat. The sentinel is on on Echo since 11:58 today.
- **Stop-hook consumers:** the handoff turn's `Stop` also reaches other listeners (notify-on-stop, the stop gate). They see an ordinary turn end.
- **Answerer:** credential-free, Bash-only, bounded (P2-3b).

## 6. External surfaces

On development agents, a real internal turn appears in a live session's pane at most twice an hour per topic, marked internal, and the awareness note (P2-4a) tells the session how to answer it. A throwaway answerer session runs per sampled fold. Nothing goes to Telegram. On the fleet nothing changes.

## 7. Multi-machine posture

Owner-only (§9.3). A non-owner machine never begins a fold, and the pool-live rule above is now implemented. The record, the holds and the shadow log are machine-local on the owner. The route reports this machine.

## 8. Rollback cost

- **Switch off** (`contextBudget.fold.shadow: false`) stops new folds at the next turn end.
- **Open records** are swept to `aborted` at boot.
- **Code** reverts with a revert.

## Class-Closure Declaration

`unbounded-self-action`: **n/a**. The runner injects into a session and spawns an answerer only on a session's own turn end, after the brakes: at most 2 asks per topic per hour, 1 in 3 clean stops, one fold per machine at a time, never queued. Each step has a wall-clock bound. It is not a self-triggered loop: there is no timer, and its own handoff turn's `Stop` is consumed, never re-triggering.

---

## Second-pass review

(appended below by the reviewer)

Concern raised:

1. **A throw between `begin()` and step 6 leaves the live topic's outbound sends refused and its inbound messages frozen until the next restart.**
   - `src/monitoring/foldShadowRunner.ts:149-219` has no try/finally around the work after `begin()`. Several calls there can throw: `d.messages` (TopicMemory sqlite), `d.archivedEntryIds` (`archive.readIndex`), `d.packetInputs` (`ledgerInputs`, `topicIntentStore.read`), `d.artifactSignals`, `d.session.inject` (`injectMessage`/tmux), `verifyHandoff` and `droppedDecisions`.
   - The boot swallows the rejection with no row and no degradation report (`src/monitoring/foldShadowRunnerBoot.ts:150`, `.catch(() => null)`). The record stays `prepared`.
   - The hold's `expiresAt` does not bound this. `FoldHoldStore.liveVerdict` (`src/monitoring/FoldHoldStore.ts:226-233`) keeps refusing an expired hold while its record is open. The inbound rows stay frozen by the same record gate (spec §9.3 "Held inbound").
   - Nothing at runtime clears it. The ContextBudgetSentinel's hold-health pass clears only holds whose record is absent or terminal, and its reconciliation acts only on `quarantined` records. `recoverPendingFolds` runs only at boot (server.ts:13982).
   - Result: the operator's conversation is muted in both directions with no notice until a restart. `begin()` also returns `fold-in-progress` for that topic until then.
   - The artifact's §1 claim "the hold expires at 3× the bound" is therefore not true on this path.
   - Suggested fix: wrap everything after `begin()` in try/catch that routes to `end('aborted', 'threw: …')`, so the carriers are released and the record goes terminal. Also add a unit test that makes a dependency throw mid-handoff and asserts the record, hold, marker and inbound hold are all released.
2. **`end()` ignores its terminal transition's result, so "every exit leaves the record terminal" is not guaranteed.**
   - `src/monitoring/foldShadowRunner.ts:158` discards the `TransitionResult`.
   - The abort is refused (`not-owner`) when `isOwner` is not `true` and `isSweepOwner` is false. See `FoldCoordinator.ts:409-411` and `foldCoordinatorBoot.ts:83`: `isSweepOwner = !poolPlacementLive`.
   - On a pool-live agent such as Echo, that happens if the live session exits mid-fold (hosts = 0) or the ownership record leaves `active`. An ownership-epoch change also refuses it (`owner-epoch-changed`).
   - The live-session carriers are released by hand, so the conversation is not muted. But the record stays `prepared` or `shadow-probing`, and the topic stays `fold-in-progress` until restart. After step 6, the staged-packet carrier is left behind as well.
   - The shadow log row still says `aborted` or `graded`, so it misreports.
   - Suggested fix: check the result. On a refusal, write the row with the refusal reason, and report it as a degradation, not silently.
3. Minor: on `handoff-timeout` (`foldShadowRunner.ts:187`) the fold hold is released while the handoff turn may still be running, so a late handoff reply is no longer covered by the outbound hold. Its late `Stop` is correctly braked by the recorded backoff, so this is not a re-trigger.

Checked and fine:
- **Wiring:** the server.ts calls match the real signatures: `holdForFold(k, f, iso)`, `releaseFold(f, iso)`, `sessionCounts().session_key`, `injectMessage(..., { firstParty })`, `terminateSession`, `issueFoldProbeToken(id, topicKey)`. `tsc --noEmit` reports no errors in the touched files.
- **Keys:** the inbound and ownership keys are the bare topic id, matching `foldKeyForConversation('telegram', …)` and `sessionOwnershipRegistry.read(String(topic))`.
- **Boot order:** the `let` TDZ read is caught as unknown.
- **Owner rule:** the pool-live rule matches §9.3 (`active`, plus this machine, plus a host), with fencing on `ownershipEpoch`.
- **Waiter race:** none. `inject` is synchronous and the waiter is registered in the same microtask chain, before any HTTP `Stop` can be delivered.
- **Release order:** the live session is released before the answerer and probe work.
- **Scope:** non-topic and non-Claude sessions are filtered, and the switch is read on every trigger.
- **Tests:** the 17 unit tests pass.

### Disposition (author)

Concerns 1 and 2 verified and fixed. Concern 3 is accepted as a residual, with the reason below:
1. **A throw after `begin` can no longer mute the conversation.** Everything after `begin()` runs inside try/catch. A thrown step calls `end('aborted', 'step-threw')`, which releases the fold hold, the live marker and the inbound hold and closes the record, and reports `step-threw: <ErrorName>` through `onDegraded` (server.ts: `DegradationReporter`, feature `contextBudget.foldShadow`). A throw before `begin` that escapes the runner is reported as `runner-threw` instead of swallowed. Test: `artifactSignals` throwing mid-handoff leaves the record `aborted`/`step-threw`, the hold and inbound released, and no marker.
2. **A refused terminal transition is recorded and reported.** `end()` checks the result. On a refusal the row says `terminal-refused: <reason>`, and the refusal is reported, so the log no longer claims `aborted` or `graded` falsely. The live carriers are released before the transition either way. To make the refusal rare on pool-live agents, `isSweepOwner` now answers yes while the topic's ACTIVE ownership record names this machine. The owner can then close its own fold after the live session exited mid-fold, which matches §9.3 ("the owner resolves its folds"). Tests: a refused transition is recorded and reported, and closing after the session left succeeds.
3. **A late handoff reply after a timeout** (minor, accepted residual). After the 5-minute bound the hold is released while the turn may still be running. The request is marked internal and asks for JSON only. The awareness note tells the session not to message the operator about it. Its late `Stop` is braked by the recorded backoff. Keeping the hold past the bound would extend the window in which the operator's conversation is held, which costs more than a possible stray JSON reply.


## Reviewer re-check

Reviewer re-check:

The fixes for concerns 1 and 2 are in the code, and the 20 unit tests plus 2 e2e tests pass. I accept concern 3 as a residual for the reason given. Re-checking the fixes turned up two remaining issues:

Concern raised:

1. **The disposition says a `terminal-refused` record "waits for the owner's sweep". On a pool-live agent no sweep ever closes it.**
   - The only sweep, `recoverPendingFolds`, runs at server.ts:13982. That is before `sessionOwnershipRegistry` is assigned (server.ts:28789) and before `_meshSelfId` is set (server.ts:31126).
   - So during the sweep, both closures read null. `isSweepOwner` returns false (foldCoordinatorBoot.ts:85-90), and the record goes to `observedOnly` (FoldCoordinator.ts:549-555).
   - At runtime, ContextBudgetSentinel reconciles only `quarantined` records, and its hold-health pass skips open records.
   - Result: a record that stayed `prepared` or `shadow-probing` after a refused abort is never closed, at runtime or across restarts. Refusals that still happen after the `isSweepOwner` fix are `owner-epoch-changed` and an ownership record that is not `active`.
   - From then on, `begin()` returns `fold-in-progress` for that topic (FoldCoordinator.ts:340), so shadow folds stop there for good. A refusal after step 6 also leaves the staged-packet carrier.
   - The live conversation is not muted, because `end()` releases its carriers first. The cost is a permanently stuck record with no notice beyond the one degradation row.
   - Suggested fix: either let the owner's runtime pass (for example the sentinel tick) abort open, lock-expired, pre-point-of-no-return records this machine wrote once ownership can be read, or run the boot sweep's fold part again after the registry and mesh id exist. Then say which one in the disposition.
2. **The releases inside `end()` (foldShadowRunner.ts:155-157) are not guarded one by one, and the catch path calls `end()` again.**
   - If `holds.release` (filesystem `rm`) or `inbound.releaseFold` (sqlite) throws, the terminal transition is never attempted.
   - The catch then calls `end('aborted', 'step-threw')`, which throws again at the same place. The error escapes to the boot as `runner-threw`.
   - That leaves the record open and the remaining carriers held. That is the original mute, now reported, but on a pool-live agent never cleared (issue 1).
   - Similarly, if `write()` throws after a successful transition, the second `end()` gets a CAS mismatch and reports a false `terminal-refused`.
   - This is unlikely: one in-process sqlite connection, and `rm` with `force`. But it is the exact path the try/catch was added for.
   - Suggested fix: wrap each release in its own try/catch and always attempt the transition. Its `settle()` releases every registered carrier again, each under its own try/catch. Also guard against running `end()` twice.

Checked and fine:
- The try/catch covers every step after `begin()`.
- `end()` checks the transition result and reports the refusal through `onDegraded`, which server.ts:36265 wires to `DegradationReporter`.
- The wider `isSweepOwner` only allows this machine's own records while an active ownership record names this machine. `ownerEpoch` still fences every transition, and on a single machine the behavior is unchanged.

### Disposition (author), round 2

Both findings verified and fixed:
1. **A refused close can no longer strand a topic.** New `FoldCoordinator.reconcileStale(topicKey, olderThanMs)` is a runtime reconcile (§9.3 Fencing: the owner reconciles the durable record). It closes this machine's OWN pre-point-of-no-return records older than the 30-minute lock ceiling as `aborted`/`reconciled-stale:<state>`, settling every carrier, including a staged packet. It is gated on the sweep-owner rule and deliberately ignores an ownership-epoch mismatch, because a record stranded by an epoch change is exactly the case. Only own, pre-PNR, lock-dead records are touched. The runner calls it before each `begin()` and reports each closure. This is the reviewer's first suggested route, the owner's runtime pass, using the runner's own trigger, with no new timer. Tests: fresh kept; stale closed after an epoch change, after which the topic folds again; nothing where another machine owns it; the runner reconciles a stuck record and then grades.
2. **`end()` is guarded.** Each release runs in its own try/catch, reported as `release-threw: <what>`, and the terminal transition is always attempted (a throwing transition reads as refused). `settle()` releases every registered carrier again. `end()` runs at most once (`ended`), so a throw after a successful close never re-runs it, and a row-write failure is reported instead of rethrown. Test: a throwing hold release still releases inbound and the marker and closes the record.

## Reviewer re-check 2

Reviewer re-check 2:

Concur with the review.

- **`reconcileStale` (FoldCoordinator.ts:471-484) cannot close a fold the runner is still running.**
  - The runner is its only caller (foldShadowRunner.ts:156), and nothing else in `src` calls `begin()`.
  - Folds on this machine run one at a time: `inFlight` (foldShadowRunnerBoot.ts:146-155) is cleared only in `finally`, so reconcile can only run when no fold is in flight here.
  - It touches only this machine's own pre-PNR records (`shadow-probing` is in `PRE_PNR_STATES`, so a post-step-6 refusal is covered). It acts only while `isSweepOwner` is true, meaning an active ownership record names this machine, and only on records older than 30 minutes, which is the lock ceiling.
  - So the 30-minute age is a second safeguard, not the one doing the work. If a second caller or another `begin()` path is ever added (for example the real fold path), the gap between `updatedAt` and the probe phase's duration would need revisiting: `renew` and `setLockWindow` do not refresh `updatedAt`.
- **`end()` (foldShadowRunner.ts:165-190) behaves as described.** It runs at most once, guards each release separately, and treats a throwing transition as refused. A row-write failure is reported and does not re-run the close.
- **Wiring:** server.ts passes the whole coordinator object, so `reconcileStale` is the real method. `tsc --noEmit` reports no errors in the touched files.
- **Tests:** 24 unit tests and 2 e2e tests pass.
- **Residual:** a stuck record on a topic is closed only at that topic's next eligible turn end (past the brakes, the estimate and the clean stop). Until then, only shadow folds are blocked on that topic, and the live conversation is not held.
