# Side-Effects Review — a message waiting for another machine is answered instead of expiring

**Version / slug:** `waiting-message-owner-cannot-take`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `independent cross-model reviewer (codex CLI), see below`

## Summary of the change

Tier 1: about 12 source and test files, about 180 source lines plus tests. Effort: one build, one review round. Feedback fb-faa9d074-e09, from the live two-machine proof of 2026-11-16. Root cause: (a) `SessionRouter.forceReplace` (the queue's final attempt) re-placed through `placeAndClaim('failover')`. For a live owner without durable receive, placement chose that owner again, so the message ran out of attempts. (b) The routing-only branch (pool at dark) claimed through `place`, which `applyOwnershipAction` refuses on any active record, so a gone peer's conversation could never be claimed and its messages expired. (c) The never-silent watcher labelled every no-local-session case `crashed`.

The fix has five parts:
- `forceReplace` first tries `takeOverFromNonReceiver`: the owner is alive, not this machine, and positively reports no durable receive. The router then takes over through a new dep, `takeOverFromPeer`, and returns `'local'`.
- The routing-only branch takes over a gone peer's active record when the plain claim fails.
- `takeOverActiveRecord` in `SessionOwnershipRegistry.ts` is a force-claim, allowed only while `fromMachine` still holds the record active.
- server.ts wires `takeOverFromPeer`. At stage dark, the queue's forced attempt for a routing-only row calls the router with `routingOnly`, which keeps the conversation on this machine and never places it elsewhere.
- Never-silent gains the structural class `waiting-for-machine` (never a judge answer). It is fed by `awaitingMachineFor`: the inbound queue holds this key and the ownership record names another machine.

## Decision-point inventory

- `SessionRouter.forceReplace` — modify — a new first branch (takeover of a live owner without receive), reached only after maxAttempts.
- `SessionRouter.placeAndClaim` routing-only branch — modify — when the plain claim fails, a gone peer's active record is taken over.
- Drain `forceReplace` wiring at dark — modify — routing-only rows get one forced attempt here, instead of `false` → attempts-exhausted.
- `NeverSilentWatcher.judgeOnce` — modify — the no-session case can read `waiting-for-machine` (wording only).

---

## 1. Over-block

Nothing new is refused. The only new refusal-shaped path is a guard on the takeover itself: a record that moved, or one not held active by the named peer, is not taken. The message then keeps waiting, which is the old behaviour.

## 2. Under-block

- A live owner whose receive capability is unknown (`null`, an older peer) is still never taken over. Its message re-places as before, which matches the existing back-compat rule.
- A message whose TTL (30 minutes) runs out before maxAttempts is reached still expires. With the defaults, maxAttempts arrives at about 20 minutes.
- The notice fix covers Telegram keys. Slack never-silent keys are channel ids, which do not match queue keys, so Slack keeps the old class.

## 3. Level-of-abstraction fit

The takeover lives in the router's existing escape hatch (`forceReplace`), which already exists to end a wait. The ownership change goes through the registry's existing `force-claim` transition (WS1.3 dead-owner takeover), wrapped in a guard. No new gate.

## 4. Signal vs authority compliance

No brittle check gains blocking authority. The takeover is gated by an existing advertised capability (`ownerSupportsForward === false`, read from heartbeat flags), plus a bounded wait. It moves a conversation instead of losing a message. `docs/signal-vs-authority.md`: this delivers rather than blocks.

## 5. Interactions

- The OwnershipReconciler / StaleOwnerReleaseEngine may later see the record on this machine. It is a normal active record with an epoch bump, the same as any failover.
- The peer's session may still be running and later find it is not the owner. That is the existing fencing behaviour (`mayRun` and epochs), the same as a dead-owner takeover.
- `emitPlacement(..., 'failover')` records the move in the placement journal.
- The live path is unchanged: it still queues `owner-lacks-ws11-receive` with no immediate steal (tested).

## 6. External surfaces

- The user sees a notice wording change.
- A conversation may move from a live machine that cannot take messages to the receiving machine, after the full wait. That machine's session would otherwise never have answered.
- No API shape change.

## 6b. Operator-surface quality

The notice sentence is plain, and has no ids or machine names.

## 7. Multi-machine posture (Cross-Machine Coherence)

This is the cross-machine path itself. The ownership change is replicated through the existing ownership registry and lease medium, the same as every placement. The notice is sent by the machine holding the message (one voice, the existing never-silent sender).

## 8. Rollback cost

Revert the commit. Records taken over stay owned by the machine that answered. That is a normal state, and the user can move a conversation back as usual. No migration.

## Conclusion

A narrow change at the two points where a waiting message could only expire, plus honest wording. The live path keeps its no-steal rule, and the forced takeover keeps every placement policy that applies to this machine, including a hard pin elsewhere (a hard-pinned conversation still waits, and its notice says so).

## Second-pass review (if required)

**Reviewer:** independent cross-model reviewer (codex CLI, read-only, fresh context; given the diff, this artifact, and the full SessionRouter.ts and SessionOwnership.ts).

**Its read: "Concern raised:"**, with five points. Each is answered below; the change was revised where needed.

1. **"The takeover reads the record, then force-claims with no expected epoch."** The read and the `cas` run in the same synchronous turn. `SessionOwnershipRegistry.cas` re-reads the record and writes through `store.casWrite`, a fast-forward CAS on the epoch, so a concurrent move from another machine returns `cas-lost` and nothing is written. The message then stays queued. No change was needed. This paragraph now states it.
2. **"`ownerSupportsForward === false` is heartbeat state, not proof; `!isMachineAlive` is not proof of death."** Agreed, and the claim is qualified. The live-owner takeover happens only at the queue's final attempt, after the whole wait (about 20 minutes), and only if the capability reads `false` (never `null`) at that moment. Every earlier attempt in the wait re-routes: a peer that recovers and flips its flag gets the message forwarded at the next attempt. The routing-only takeover uses the same liveness signal that the existing dead-owner failover in `dispatchOne` already acts on. If a recovered peer loses its record, it is fenced by the epoch, as in any failover.
3. **"The live-owner takeover bypasses placement policy."** Valid, and fixed. The takeover now asks `placement.decide` with only this machine offered (`localPlacementAllowed`). A hard pin to another machine, an offline or blocked machine here, or any escalation means no takeover, and the normal forced re-place runs. Two tests were added: a hard pin, and this machine offline. The routing-only branch keeps its existing design: it never consults placement, the same as the live path at dark.
4. **"confirmClaim and the 'local' contract."** The reviewer agreed that skipping confirmClaim after a force-claim is correct. The 'local' contract is exercised end to end by the E2E test: the real QueueDrainLoop delivers locally after the takeover.
5. **"The existing CAS-loss → forward → failover cycle can repeat."** This is pre-existing and not introduced here. It was triaged to the feedback queue (fb-b0949c7e-962), not fixed in this change.

**Status:** concerns 1 and 4 hold as written; 2 is qualified; 3 is fixed; 5 is routed to the feedback queue (fb-b0949c7e-962).

**Second round (same reviewer, revised diff): "Concur."** It confirmed that the placement check closes the policy bypass, that the synchronous guard-to-CAS path is sound, and that 'local' keeps the drain contract. One wording note: the flag is checked at the moment of takeover, not throughout the wait. Point 2 above now says exactly that.

## Evidence pointers

- Unit: tests/unit/SessionRouter.test.ts (9 new), tests/unit/neverSilent-watcher.test.ts (4 new).
- Integration: tests/integration/waiting-message-owner-cannot-take.integration.test.ts (6).
- E2E lifecycle: tests/e2e/waiting-message-owner-cannot-take.test.ts.
