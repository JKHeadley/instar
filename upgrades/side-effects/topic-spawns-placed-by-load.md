# Side-Effects Review — Topic-bound agent spawns placed by load (placement Step 2)

**Version / slug:** `topic-spawns-placed-by-load`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Spec:** `docs/specs/topic-spawns-placed-by-load.md` (converged in 7 rounds; approved by the Chief of Staff, msg a8f9ad3f, with 3 fold-ins)
**Second-pass reviewer:** `independent subagent` (required: session spawn, ownership gate)

## Summary of the change

When `multiMachine.placement.agentSessions.topicBound` resolves on (development agents only), an agent-started `/sessions/spawn` with `placement: "auto"` and a `topicId` whose topic has no live owner can start on a less-loaded peer. Conditions:
- this machine holds the pool lease and is busy;
- the brief fits one replicated record and the record is accepted;
- the peer advertises `agent-brief@1`.

The brief is replicated to every pool machine as a `topic-spawn-brief` record. It travels to the peer as an ordinary forwarded first message, sent through the fenced `startCheckedTopicOnMachine` path with a structural agent authorship marker. The target starts it as a fresh agent task (`agentTask` framing).

With the flag on, every topic-bound spawn into a topic owned by a peer is refused with `409 topic-owned-elsewhere`.

## Decision-point inventory

- Whether a topic-bound auto spawn starts on a peer: judgment-candidate. The floor is the verdict plus memory pressure; Step 1's `decide` judges above it.
- Refusing a topic-bound spawn into a topic owned by a peer: invariant (ownership record).
- Whether a forwarded message is agent-authored: invariant (origin equals signed sender).

## 1. Over-block

- With `topicBound` on, every topic-bound `/sessions/spawn` into a topic owned by a peer now gets `409 topic-owned-elsewhere`, whether or not it asked for placement. A caller that used to start a second session there (which the route only logged as a "possible duplicate copy") is now refused. That is intended: the second session would never receive the topic's messages. The answer names the owner and whether it is reachable.
- On a fallback where no local claim seam is wired, the route answers `503` and starts nothing, instead of spawning blindly. This applies only with the flag on and a topic-bound auto request. Today's route is unchanged when the flag is off.
- Dev-gated: none of this runs on the fleet.

## 2. Under-block

- A spawn without `placement: "auto"` into a topic with no owner, or one owned by this machine, behaves exactly as today. Ownership races on that path are what they were before this change.
- Holders of the replicated brief: no per-peer replication position is exposed, so the attention item reports only this machine (when its own copy reads back) as holding it. Every other machine shows "not yet confirmed", never assumed. Recovery from a third machine works once that machine has synced, but the item cannot prove it has. This differs from the spec, which reports holders from replication cursors; that per-peer position is not exposed today. It is accepted, and it reports `not yet confirmed`, never an assumed holder.
- If a live session already holds the topic on the target, a forwarded agent brief goes in as an ordinary message, not with fresh-task framing. Placement only targets topics with no live owner, so this happens only in a race.
- A peer that advertises `agent-brief@1` but crashes mid-start leaves the topic claimed. The `unknown` path keeps the claim and raises an attention item. A person decides; nothing restarts the work automatically.

## 3. Level-of-abstraction fit

The placement reuses `startCheckedTopicOnMachine`, the fenced path a person's first message already takes to a peer. It reuses the target's existing forwarded-message arm and the existing replicated-record mechanism (`ReplicatedKindRegistry`). There is no new transport and no new state machine. The new modules are a pure decision file (`topicSpawnPlacement.ts`) and one replicated store (`TopicSpawnBriefReplicatedStore.ts`).

## 4. Signal vs authority compliance

The placement decision is a judgment-candidate. Its floor is the deterministic verdict and memory check plus the ownership record, and Step 1's `PlacementExecutor.decide` is the arbiter above that floor. The 409 rests on the ownership record, which is already the authority for who runs a topic. The agent-authorship check is structural: the origin must equal the signed mesh sender. No brittle text match holds blocking authority.

## 5. Interactions

- **Step 1 (PR 3382):** this stacks on it and extends its shadow rows (topic id plus ownership state) and its reconciliation (match by topic, learn the target's real session name).
- **Forwarded-message arm:** a verified agent message gets `agentTask` framing and a null media id. A person's forwarded message is unchanged. A mismatched or partial agent claim is refused and not injected.
- **Studio overload brake (`/work-admission`):** a placed spawn runs on the peer and passes through the peer's own admission there.
- **Replicated journal:** one new kind is registered in `CoherenceJournal`, `JournalSyncApplier` and `ReplicatedStoreReconcilerWiring`. Older peers drop an unknown kind forward-compatibly.

## 6. External surfaces

- `/sessions/spawn` answers gain `202 peer-accepted` (with `tmuxSession: null`), `202 unconfirmed`, `409 topic-owned-elsewhere` and `503` on fallback. All are behind the dev gate.
- The capacity heartbeat always carries the `agent-brief@1` key. Its value is `true` only while the gate is on, and peers place onto a machine only when it reads `true`.
- A new replicated record kind, `topic-spawn-brief`, carries credential-redacted task text to this agent's own pool machines only.
- The session prompt opens with a "NEW TASK" line, instead of "CONTINUATION", for a placed brief in a topic that has history.

## 7. Multi-machine posture (Cross-Machine Coherence)

`unified`. The decision reads the pool's heartbeats, and the claim is the shared ownership record. The brief is replicated to every pool machine. The audit and shadow rows are per machine, as in Step 1. They are excluded in `machineCoherenceManifest` with the same reason Step 1 gives.

## 8. Rollback cost

Set `multiMachine.placement.agentSessions.topicBound: false` and restart: every decision returns to today's behaviour. A few pieces stay inert with the flag off: the forwarded-arm classifier still runs but acts only on a verified agent claim, which no peer sends while the flag is off; the journal kind stays registered; and shadow rows carry two extra fields. Or revert the PR. Replicated `topic-spawn-brief` records that remain are inert: no reader acts on them with the flag off, and they are never deleted. There is no migration.

## Class-Closure Declaration

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a` (negative declaration)
- **Reason:** this is a one-shot, caller-driven action. Each placement runs once per `/sessions/spawn` request from an agent. Its reconciliation is a fixed 3-read check, and an unknown outcome waits for a person instead of retrying.

## Conclusion

Dev-gated placement of agent-started topic work onto a less-loaded peer, through the existing fenced first-message path. Briefs are replicated, and a topic that is already owned is never started a second time.

## Second-pass review (if required)

**Round 1 (independent subagent, 14:42 PT): concern raised.**
- A `start-superseded` result whose deliver was `accepted` or `unknown` fell through to the local claim and spawn, which could duplicate a session the target had already started (`topicSpawnPlacement.ts:285-291`). Fixed: only `delivered: 'rejected'` falls back. Accepted or unknown answers 409 if a peer owns the topic, else 202 `unconfirmed`, with tracking kept. Two new unit tests cover it.
- The fallback re-emitted the brief with `placedOn: self` before the claim. Fixed: it now does so only after a 201.
- Wording in §2, §6 and §8 corrected (heartbeat key always present; inert pieces with the flag off; brief holders listed as an accepted difference from the spec).

The reviewer found authorship, redaction, the 409, the unknown path and the fallback claim sound.

**Round 2 (same reviewer, 14:45 PT): Concur with the review.** All three fixes verified at file:line; 42/42 unit tests pass and tsc is clean.
