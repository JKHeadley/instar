<!-- bump: patch -->
## What Changed

The second piece of the Chief of Staff (docs/specs/chief-of-staff-topic.md §2.4): the action protocol. Every side-effecting action the Chief of Staff will take (restart a stalled project by injecting a continuation or starting a bounded run, redirect a drifting one) now has one durable state machine — `claimed → executing → started | superseded | rejected | lost | aborted` — recorded as immutable events in the `chiefOfStaff` replicated store. The lease holder signs each claim; the conversation's ownership machine verifies that signature against the current lease holder and a fresh renewal, re-checks ownership, the open-intent rule and the stand-down list under the conversation lock, writes `executing` and waits for it to be fsynced before doing anything, and records `started`. Recovery never marks an action lost without the owner's tombstone; a new owner refuses to act until the previous owner's open intents have outcomes; duplicates return the recorded outcome. Two mesh verbs (`cos-action`, `cos-settle`) carry this between machines. The Liveness Reconciler, the resume queue and the silence heartbeat each gained an optional stand-down read so they never act on a conversation the Chief of Staff is acting on. Autonomous run records can carry `cosNoRespawn` and `idempotencyKey`. The `chiefOfStaff` config block and its dev-gate entry are declared.

Dormant: nothing calls the protocol yet (the check-in loop is the next release), the operator check-in lease reads as expired until that loop derives it, and the protocol is constructed only where `chiefOfStaff.enabled` resolves on (development agents; dark on the fleet).

## What to Tell Your User

Nothing yet. No conversation, notice, setting or behaviour changes in this release.

## Summary of New Capabilities

- `ChiefOfStaffActionProtocol`: claim / execute / settle / stand-down with holder-signed commands, durable `executing` before side effects, dedupe index rebuilt from durable sources, transfer barrier, compensation by exact run id.
- Mesh verbs `cos-action` and `cos-settle` (registered-peer class; the handler is the gate).
- Optional `cosStandDown` / `cosSuppress` deps on the Liveness Reconciler, resume queue drainer and progress heartbeat.
- `AutonomousRunStore`: `cosNoRespawn`, `idempotencyKey`, `findByIdempotencyKey`, `blockingStateForTopic`.
- Config block `chiefOfStaff` + dev-gated `chiefOfStaff.enabled`.

## Evidence

- `tests/unit/ChiefOfStaffActionProtocol.test.ts` (22): happy paths, every refusal, routing, durability failure, duplicates, reboot, compensation, claimed-vs-claimed, executing-vs-claimed, crash recovery both ways, unreachable owner, transfer barrier, unreadable index.
- `tests/unit/chief-of-staff-standdown-deps.test.ts` (10): run-store fields and lookups, RBAC class, reconciler dep both sides and throwing.
- `tests/unit/chief-of-staff-protocol-wiring.test.ts`: real seams wired in server.ts, handlers registered, deps fed, union + RBAC, dev-gate entry, darkness scan.
- `tests/integration/chief-of-staff-protocol.test.ts`: two real journals, real Ed25519 keys, production applier; routed execute, cross-apply convergence, dedupe, forged signature rejected, expired lease refused.
