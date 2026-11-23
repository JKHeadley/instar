# Side-Effects Review — The fence, part two: a machine below the minimum build doesn't hold the lease or get work

**Version / slug:** `identity-security-piece2d-fence-lease-routing`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Piece 2d of the approved identity and security design (topic 144636). Nothing applies until piece 3 enrols an owner above Basic with a minimum build.

- **The agent-wide hold.** `ownerRecordStore.gate()` holds Sensitive and Serious actions while any registered machine is below the fence (`machine-below-fence`), or alive but with no signed build statement for 24 hours (`machine-unconfirmed`). `ownerRecordSync.machinesHeld()` and `isBelow()` feed it.
- **Every mesh verb classified.** `src/core/meshVerbFenceClass.ts` has a compiler-exhaustive table (liveness, read, conversation, work, authority) and a live policy hook. `MeshRpcClient.send` sends no work or authority to a below machine; conversation is allowed only for a session it actively owns at that epoch. `MeshRpcDispatcher` refuses authority from a below machine after signature and RBAC.
- **The lease.** `FencedLease.canAcquire` gains a separate `belowFenceHolders` input. `LeaseCoordinator` reads it live and counts takeovers against a budget of three per below machine per day per updated machine (`PeerBuildLedger`). A below preferred captain counts as no preference, both in the survivor rule and in the handback reconciler.
- **No new work, no remote typing, no self-claims.** `PlacementExecutor` leaves below machines out of placement. The dashboard (`WebSocketManager.relayWrite`) and the phone relay (`mobileSessionTerminalRoutes`) refuse remote input to a below machine. `OwnershipApplier` skips ownership claims a below machine writes for itself; its releases still apply.
- **Guards and notice.** This build reports the guards `fence-lease` and `fence-routing` in its pulls. The owner notice gains a hold sentence, and the awareness entry gains a line.

## Decision-point inventory

- The gate's two new hold reasons.
- The verb policy, to and from a below machine.
- The lease takeover input and its budget.
- The placement filter, the remote-input refusal and the ownership-applier skip.

## 1. Over-block

- **Before enrolment:** nothing.
- **After enrolment,** the hold stops only Sensitive and Serious actions, and viewing continues.
- **A sleeping machine** sends nothing, so it never triggers the hold.
- **Existing conversations** on a below machine continue (conversation class), so no failover and no double replies.

## 2. Under-block

A hand-installed old build still acts on its own direct inbound. That is the stated residual; the agent-wide hold makes every updated machine safe regardless.

## 3. Level-of-abstraction fit

- **One shared decision,** the gate.
- **One exhaustive table,** enforced at the two mesh choke points.
- **Small hooks** in lease, placement, remote input and the ownership applier. They read a tiny predicate, so they don't import the owner-record machinery.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — deterministic checks over enumerable inputs (verb type, signed build statements, ownership records); no judgment over meaning.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

- **Takeovers:** three per below machine per updated machine per day. The count settles, and the hold covers privileged effects.
- **The 24-hour window,** from 2c.

## 5. Interactions

- **Mesh:** a refused send returns `409 below-minimum-build` without a network call, and a refused receive is logged through `onReject`.
- **Agent-to-agent:** a refused delivery returns undelivered, never a failover.
- **Lease:** the presumed-dead set is untouched.

## 6. Rollback

Revert the commit. The policy and predicate default to refusing nothing.

## 7. Evidence

- **Unit:** `tests/unit/identity-piece2d-fence-lease-routing.test.ts` covers:
  - the table ratchet;
  - direction;
  - the policy, including a conversation only to the active owner at its epoch;
  - client refusal before any network call;
  - the predicate;
  - `canAcquire` with the new input;
  - the takeover budget;
  - the gate's hold reasons;
  - the held list (below, alive but unconfirmed, asleep).
- **Dispatcher with signed envelopes:** `tests/unit/MeshRpc.test.ts`.
- **Regression:**
  - FencedLease and LeaseCoordinator (convergence, self-heal, handback): 69 tests;
  - MeshRpc, OwnershipApplier, PlacementExecutor and WebSocketManager: 146 tests;
  - self-action convergence and the guards.
- **E2E lifecycle:** the 2b lifecycle file now expects the live guards in pulls.
- **Live graduation:** with piece 3's mixed-version proof, as the spec's maturation plan says.

## Second-pass review

An independent reviewer subagent probed the code. Round 1 found four defects, all fixed with regression tests:
- **The takeover budget:** two ledger copies overwrote each other. Now there is one shared instance per file.
- **A below standby's replies were silenced:** `telegram-origin` is now conversation class, and a submit is allowed for a topic it actively owns.
- **The ownership skip dropped topics the machine really holds:** it now skips only a claim that would displace a different active owner.
- **A fence refusal could mark the owner suspect:** it now answers as `stale-ownership` (the record no longer names that owner at that epoch), so the router looks the owner up again and never marks it suspect or handles the message locally (round 2).

Smaller fixes:
- `handback-offer` is `work`.
- The hold's "alive" counts only verified envelopes.
- The coordinator never defers to a below captain.

Review: `.instar/state/identity-build-144636/reviews/p2d-second-pass.md` in the agent home.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** 2d adds no self-triggered loop. Lease takeover is an input to the existing acquire tick, bounded by a fixed budget; the notice is 2c's registered one.

## Addendum: rebase onto main (2026-11-21)

Main gained six mesh verbs for the Gemini pay-per-use lane while this piece waited. The fence table is
compiler-exhaustive, so each needs a class before the branch builds:

- `metered-gemini-call` is **authority**: it asks the designated machine to spend money, so it is never sent to a
  below machine and is refused from one, like `slice-renew`.
- `metered-gemini-result`, `designation-echo`, `secret-names` (key names only, never values) and
  `gemini-payg-setup-render` (rendering is not authority; the PIN commit is) are **read**.
- `metered-stop-action` is **liveness**: it can only reduce spending, and a below machine must still be able to
  stop money.

Side effects: none before enrolment (the fence applies nothing until the owner enrols above Basic). After
enrolment, a below machine cannot start a metered call and cannot be the one asked to spend; it can still stop
spending and read results. Tests: MeshRpc, piece 2c and 2d unit tests and 20 lease and mesh test files pass.

## Current-main Merge Repair (2026-11-22)

Normally merge corrected prerequisite3445 at b62d9418a361e6d2b387e6b1a010e259782c4911, including main9b61d628, into the existing2d branch. No rebase or force. The two conflict hunks in LeaseCoordinator preserve both sets of approved behavior: main's lapsed/superseded planned-restart verdicts and stall-confirmed-claim evidence, plus2d's separate belowFenceHolders eligibility input and successful-takeover budget record. The presumed-dead set remains separate. Main's stall reconfirmation feature, restored in3445 after an earlier merge accidentally deleted it, remains intact in source, wiring and tests. No deleted paths versus current main.

No new authority, routing class, timing threshold, proof, record schema or default is introduced by this repair. Existing guard decisions and owner build-floor enrollment remain the approved spec's decisions. The existing mesh and lease hooks retain their production owners. This is unrelated to the three stopped native-handoff designs.

## 6b. Operator-surface Quality

No screen, user-facing copy, primary action, URL or approval journey changes in this merge repair. Existing minimum-build refusals still name the version needed; existing stall and planned-restart status remain main's implementation. There is no new raw internal content or destructive action for a person to interpret. Existing native/Telegram notice carriers are unchanged by this source merge, with no delivery or live-approval claim.

## 8. Merge Interactions, Multi-machine Evidence and Rollback

The lease remains one shared cross-machine authority. Preserve main's peer pulls, boot hold and post-stall reconfirmation before acquisition CAS; preserve separate below-build budget eligibility and count only successful takeovers. No machine-local fallback or fabricated human proof is added. Rollback should be a forward correction preserving both guards: reverting to the stale branch would restore its accidental removal of main behavior. No live state or installed files are changed here.

Independent read-only source reviewer concurred after comparing against corrected3445/current main: all boot-reclaim/stall guards precede CAS, both success records remain, and belowFenceHolders does not contaminate presumedDead. Focused112unit tests in six fence/lease/reclaim files passed;3HTTP join-fence tests and5production owner-record lifecycle tests passed; TypeScript checked clean. These are supporting checks, not a shared full pass. Full verification and all dependency/order holds remain with echo-increasing-throughput.

## Main refresh after the minimum-build prerequisite landed, 2026-11-23

Tier 2 maintenance under the existing approved spec. Normal merge of current main c7a2f64581058fb60b1f25767f3f9a09543f05bf into prior 207df123684fa64f91262ba2ba27242399f5e792 encounters six files overlapping the now-squashed 2c prerequisite: identityBuildFence, ownerRecordStore, ownerRecordSync, ownerRecordWiring, owner-record awareness and the existing production lifecycle E2E. Retain each existing 2d hunk: shared ledger/takeover accounting, below/unconfirmed holds, verified-envelope liveness, live guard advertisement and wiring, and the corresponding E2E expectation. No new decision, threshold, replication rule or owner authority is introduced.

Independent parent source review compared the actual six resolutions with prior 207df123 and current main, and concurred. The six resolved files retain their previous intended 2d implementation; main stall/reclaim and native-decommission lifecycle protections remain, along with the distinct belowFence eligibility input. There are no unresolved hunks or deleted paths against main. Existing over-block, under-block, signal-versus-authority, interactions, multi-machine and rollback analysis above applies unchanged.

Focused current-candidate verification passed 118 unit tests in five files (2c, 2d, MeshRpc, stall reconfirmation and planned restart), 11 real HTTP integration tests in two files, all five production owner-record lifecycle E2E cases and TypeScript checking. These focused checks are not full-suite clearance. Throughput confirmed no active run or reservation before editing. Full verification remains delegated exclusively to that coordinator, and every native/authority/dependency release hold stays in force. One independent merge-review pass; no new convergence round. Rollback uses a normal correction retaining both the fence and current main guards; no live state or installed files changed.
