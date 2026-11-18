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
