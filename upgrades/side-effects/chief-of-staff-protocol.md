# Side-effects review — Chief of Staff PR 2: the §2.4 action protocol (wired, dormant)

**Spec:** docs/specs/chief-of-staff-topic.md §2.4, §2.6, §2.7, §4 (converged, approved 2026-11-09). Builds on PR 1 (#2998).
**Tier:** 2 (touches the autonomous-run path, three run producers, the mesh command union, a dev-gated feature flag).
**Change size:** new `src/core/ChiefOfStaffActionProtocol.ts` (~420 LOC); additive fields + two lookups on `AutonomousRunStore`; one optional dep each on `AutonomousLivenessReconciler`, `ResumeQueueDrainer`, `AutonomousProgressHeartbeat`; two mesh verbs in `MeshRpc.ts` (union + registered-peer RBAC class); `chiefOfStaff` config block + dev-gate entry; server wiring (protocol construction behind the gate, two mesh handlers, three stand-down reads). Tests: 2 unit files (protocol state machine 22 cases; deps/registry/RBAC 10 cases), 1 wiring file, 1 integration (two real journals + real Ed25519 keys + production applier).
**Effort:** build attempts 1; type/scope fixes 2 rounds before green.

## Summary

The durable state machine every side-effecting Chief of Staff action goes through: `claimed → executing → started | superseded | rejected | lost | aborted`, with the ownership machine's conversation lock as the only serialisation point, a holder-signed inner command verified against the current lease holder + a fresh renewal, `executing` fsynced before any side effect, an in-memory dedupe index rebuilt from durable sources only, recovery that never marks `lost` without the owner's tombstone, a transfer barrier on adoption, and compensation by exact run id. **Nothing calls `claim()` yet** (a wiring test scans `src/`). The protocol is constructed only where `chiefOfStaff.enabled` resolves on (dev-gate: live on a development agent, dark on the fleet) and `operatorLeaseLive()` is wired to `false` until PR 3 derives the real lease, so even a routed command from a peer is refused `operator-lease-expired` today.

## 1. Over-block
Every refusal is a hard invariant on an enumerable domain (signature, holder identity, renewal freshness, ownership, operator lease, backoff gate, open-intent rule, stand-down, dedupe index readability). The deliberate conservative choices: a dep that throws resolves to refuse/stand down; an unreadable run registry blocks; the heartbeat suppresses a CoS-started run only when the lease is expired. The one place this could over-block legitimate work is the three run producers' new `cosStandDown` dep — it fires only when a CoS intent for that topic is OPEN in the replicated store, and nothing writes intents yet. No issue identified in this PR; the risk belongs to PR 3's loop cadence.

**Design point surfaced by the integration test (not in the spec text):** a routed `cos-action` normally arrives at the owner BEFORE the holder's `intent` record has replicated. Rejecting it would make every cross-machine action fail on first try. The owner therefore treats the VERIFIED command as the claim it is (same key, same holder machine, same signature, holder's `claimedAt` carried in the command), writes an identical intent record on its own stream, waits for it to be durable, and proceeds. The substrate keeps one record per key, so after replication both machines hold the same intent; the fold's `machine` field is the holder's in either copy, so the transfer barrier and arbitration are unaffected. A command that fails signature/holder/freshness verification never reaches this step.

## 2. Under-block
`verify` depends on `MachineIdentityManager.getSigningPublicKeyPem(machineId)` knowing the holder's key; an unknown machine fails closed. `ownerOf` falls back to self when the ownership registry has no record (single-machine agents), which is correct there and is the reason the transfer barrier + lease-holder check exist for multi-machine. `operatorStoppedSince` defaults to "stopped" when the shared closure is not yet assigned. Carried to PR 3: the `actionGate` dep is a stub (`nextActionAllowedAt: null`) until the loop computes the fold; the stub cannot allow an action because `operatorLeaseLive()` is `false`. `findByIdempotencyKey` scans current records only (the daily sweep archives predecessors); settlement runs within a tick, long before a sweep.

## 3. Level-of-abstraction fit
The protocol sits between the loop (PR 3, judgment/signal) and the existing primitives (spawn, inject, run registry, lease, ownership, mesh). It adds no parallel transport (mesh verbs ride `MeshRpcClient`/`/mesh/rpc`), no parallel store (records go through PR 1's kind), and no parallel lock (`SessionManager.withConversationLock`). The three run producers gain an optional dep rather than a new coordinator.

## 4. Signal vs authority compliance
No judgment-based blocking is added. The refusals are identity/idempotency/ownership mechanics — the principle's own carve-outs. The LLM judge (PR 3) will be an input to `claim()`, never a gate here.

## 5. Interactions
- **Reconciler / resume drainer / heartbeat:** each reads `cosStandDown`/`cosSuppress` only when the dep is present; absent ⇒ byte-for-byte prior behaviour (tested both sides). The reconciler maps a CoS stand-down to the existing `blocked-queue-owns` condition (no new union member, no ripple into enumerating tests).
- **Mesh RBAC:** `cos-action`/`cos-settle` join the registered-peer class, exactly like `a2a-topic-reply-inject`; the handler is the gate. `verifyEnvelope` still proves the sending machine; the inner signature proves the HOLDER.
- **Run registry:** two optional fields; `findByIdempotencyKey` reads current records (archived predecessors are on disk and are not scanned — a settle after an archive sweep would tombstone instead of find; acceptable because the sweep runs daily and settlement runs within a tick).
- **Lock:** `execute` calls `withConversationLock` once and never re-enters; the executors it calls (`injectTelegramMessage`) take no lock. `startRun` is deliberately unwired (throws, recorded `aborted`) until PR 3 provides the registration + spawn under the `*Unlocked` entry point.

## 6. External surfaces
Two new mesh verbs (refused `cos-disabled` where the protocol is not constructed). An injected continuation prompt carries an explicit `[chief-of-staff automated — not operator words]` provenance header. No route, notice, or app field.

## 6b. Operator-surface quality
Not applicable: no dashboard/app/console change.

## 7. Multi-machine posture (Cross-Machine Coherence)
Unified by construction: every protocol fact (`intent`, `executing`, `started`, `rejected`, `superseded`, `lost`, `aborted`) is an immutable record in PR 1's replicated kind, written BEFORE the step that depends on it; the dedupe index is in-memory over the local journal stream + peer streams + the run registry and is rebuilt on boot and on adoption; the transfer barrier refuses on a new owner until the previous owner's open intents have outcomes; the holder signature + fresh-renewal check means an isolated former holder cannot be authorised and an isolated owner (stale lease view) refuses. The integration test runs two real journals with real keys and the production applier. No machine-local surface.

## 8. Rollback cost
`chiefOfStaff.enabled: false` (or the fleet default) ⇒ the protocol is never constructed: handlers answer `cos-disabled`, the three deps return null, no record is written. The additive run-store fields are inert. Revert is clean.

## Second-pass review (Phase 5) and what changed because of it
Concern raised (independent reviewer, 2026-11-09 13:00 PT) and resolved before commit:
1. **Seq arithmetic overshoot** — the wiring derived the record seq as `lastSeq + pendingCount`, but `pendingCount` counts queued entries of EVERY kind, so a busy journal would have made every `awaitDurableSeq` time out (refuse, never execute early — but 5 s under the conversation lock). Fixed structurally: `ReplicatedRecordEmitter` now calls `CoherenceJournal.emitReplicatedRecordWithSeq` when the seam offers it and surfaces `seq` on `EmitResult`; the wiring and the integration test use that. No arithmetic remains.
2. **Unauthenticated commands wrote records** — a `rejected` outcome was written even for a forged signature / wrong holder, letting any registered peer populate the store or pre-reject a predictable key. Fixed: refusals before authentication (`invalid-command`, `holder-signature-invalid`, `not-current-holder`, `holder-lease-stale`) write nothing (tested).
3. **Replay window** — `verifyCommand` now requires `cmd.leaseEpoch === currentEpoch()` (§2.6) and a signed `claimedAt` no older than one run ceiling and not in the future; the payload (injected text, duration) and `claimedAt` are inside the signed tuple, so a forwarder cannot alter what is injected (tested: tampered payload ⇒ `holder-signature-invalid`).
4. **Transfer barrier wording** — the barrier is enforced inside `execute()` (an open intent from another holder's claim ⇒ `transfer-barrier`); `adopt()` is the boot/adoption pre-check PR 3's loop calls. The artifact previously implied `adopt()` was on the execute path.
6. **`settle()` authentication** (second reviewer pass) — `settle()` verified only that the signature matched the self-declared holder id, so any registered peer could tombstone a predictable key before the real command arrived. Now it requires the signer to be `currentHolder()` with a fresh renewal AND the intent to exist, claimed by that holder, for that conversation; anything less answers `unknown` and writes nothing (tested).
5. **Fail-closed stand-down** — `hasOpenIntent`/`standDown` answered "no intent" when the union could not be read. Now an unreadable union answers stand down (`registry-unreadable`), so the Reconciler / drainer / heartbeat deps fail to the safe side (tested).

## Found problems (triage)
- `ReplicatedRecordEmitter.emit` did not return the journal seq → fixed in this PR (additive `seq` on `EmitResult`); the feedback item `fb-b50f03ac-0d2` filed during the build is superseded by the fix.
- `AutonomousRunStore.findByIdempotencyKey` cannot see archived records → noted above; follow-up folds into PR 3's recovery tick (it settles within a tick, before any sweep).

## Proportion
Tier 2, ~1,100 LOC incl. tests, 1 build attempt. In line with a coordination protocol.

## Second-pass verdict
Three passes by an independent reviewer (Explore subagent, 2026-11-09 13:00–13:14 PT). Pass 1 raised the seq-derivation and unauthenticated-write concerns above; pass 2 confirmed those fixes and raised the `settle()` authentication gap; pass 3: **"Concur with the review"** — every `settle()` check fails closed before any write, `execute()` enforces the same holder/freshness floor, no path lets a non-holder create or settle a record.
