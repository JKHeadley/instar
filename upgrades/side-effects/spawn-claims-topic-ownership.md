# Side-Effects Review — topic-bound spawns claim pool ownership; transfer spares a run on the target

**Version / slug:** `spawn-claims-topic-ownership`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose subagent (read-only diff review)`

## Summary of the change

Tier 2: it touches cross-machine ownership authority, under the approved and converged spec `docs/specs/ownership-follows-live-work.md` (Part B). Size: 7 source and doc files plus 3 test files, about 250 lines.

1. `POST /sessions/spawn` with a `topicId` now calls the existing Part B claim-on-spawn action, so the pool records this machine as the topic's owner. Before, the route bound the session only locally (`registerTopicSession`). The pool then read the topic as `unowned`, and a peer's router started a second live copy on the next inbound message. This was reproduced live on topics 136774 and 10000001485 on 2026-11-03. The claim action moved out of a `server.ts` closure into `createClaimOwnershipOnSpawn` (`src/core/ownershipFollowsLiveWork.ts`), so both callers (the autonomous respawn and the spawn route) share one implementation. It is wired through `AgentServer` options into `ctx.claimTopicOwnershipOnSpawn`. The 201 body reports the result as `ownership`.
2. `POST /pool/transfer` now counts a live autonomous run for the WS1.4 consent gate and for suspend-on-move only when the run is on a machine the topic is leaving. A run on the transfer target is not interrupted by the move.

Files: `src/core/ownershipFollowsLiveWork.ts`, `src/commands/server.ts`, `src/server/AgentServer.ts`, `src/server/routes.ts`, the spec and its ELI16, tests.

## Decision-point inventory

- `POST /sessions/spawn` ownership write — **add** (a call into the existing Part B action; never force-claims a peer-owned topic).
- Part B claim action — **modify (refactor only)**: same CAS sequence, nonces, audit row and fail-closed paths. It now returns an outcome string.
- `/pool/transfer` WS1.4 run selection — **modify**: excludes a run on the resolved target machine.

---

## 1. Over-block

The spawn change has no block/allow surface: the spawn always proceeds, whatever the claim does. The transfer change removes a prompt. It never adds one.

## 2. Under-block

- An agent can still spawn a topic-bound session on machine A while machine B owns the topic. The claim is withheld (`owned-elsewhere`, logged and reported in the response), and two copies can exist. That is a deliberate spawn against a known owner, and the duplicate reconciler and stand-down own convergence for it. Refusing the spawn would be new block authority, which this change does not take.
- Sessions spawned before this fix still have no record until their next respawn or until a user message is routed. The live duplicate on 136774 still needs a transfer to the Studio. After this change, that transfer no longer pauses the build.

## 3. Level-of-abstraction fit

This uses the existing ownership funnel (`SessionOwnershipRegistry.cas` plus `emitPlacement`, enforced by `lint-cas-emit-placement`) and the existing Part B helper. No new mechanism. Moving the closure into core makes it unit-testable and stops the two callers from drifting apart.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Ownership is authority, and every write goes through the same fenced-epoch FSM as before. A peer-owned record is never taken (FD3). The transfer change narrows when a consent prompt appears, using a deterministic fact: whether the run is on the target.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Whether a run is on the destination machine is a fact the move cannot change, not something that needs weighing.

## 5. Interactions

- **Double-claim with `route()`:** a spawn whose topic `route()` already placed and claimed reads `active@self` and gets `already-owned`, with no CAS and no epoch bump.
- **Duplicate reconciler:** with the record written at spawn, the `rule2-rule3-contradiction` escalation (epoch on a peer while the live run is here) no longer arises from this path.
- **Races:** if a peer places first, `place` loses (`lost`) and no claim is attempted. FD11 is unchanged.
- **Transfer drain leg:** unchanged. The owner leaving the topic is still drained, so its stray copy is closed. Only the local or owner run selection excludes the target.
- **Confirmation challenge:** the hash still covers `runKey`/`runGoal` of the selected run. A run on the target is no longer selected, so it is not part of what the caller consents to.

## 6. External surfaces

The `POST /sessions/spawn` 201 body gains an `ownership` field, which is additive. Placement journal entries (`placed`) now appear for direct topic-bound spawns, on the same replication path as before. No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Replicated:** the claim rides the existing ownership CAS plus the coherence-journal `placement` kind that peers apply. Single-machine agents and fleet agents with the flag dark get `dark` or `unwired`: no write, behavior unchanged. No user-facing notices, no new durable state, no URLs.

## 8. Rollback cost

Pure code change. Revert and ship a patch. The ownership records written are ordinary `active` records that the existing release-on-complete and reconciler paths already manage. No migration.

## Conclusion

This closes the gap the spec itself named ("If a future autonomous start path spawns directly, it MUST thread the same claim"): `POST /sessions/spawn` was such a path and did not. It also fixes the transfer side problem. The two related findings are filed separately: the 61449 hard-pinned duplicate with its clamped breaker (fb-8b071eb7-b4d), and the message log naming the locally bound session instead of the delivery target (fb-744b5a6e-bf7).

## Second-pass review (if required)

**Reviewer:** independent subagent (read-only review of the diff, without my conclusions)
**Independent read of the artifact:** concur, with fixes applied

- The extracted claim action behaves the same as the old closure for the autonomous-respawn caller (nonces, audit row fields, fail-closed paths). No inbound-router caller of `/sessions/spawn` exists. Transfer target resolution matches the planner's. The challenge hash still covers what the prompt shows.
- **Applied:** a `placing` record on this machine, or a `transferring` record naming this machine, was misreported as `owned-elsewhere`, with a misleading audit row. It now returns `in-flight` and writes nothing, with unit tests on both sides. The wiring fallback now reports `unwired` instead of `dark` when the pool block never built the claim. Added a test for a won place followed by a lost claim.
- **Stated, not changed:** the fix follows the existing dev-agent gate, so it is `dark` on fleet agents until the flag graduates. That is the spec's rollout path, and graduating the flag is a separate decision. The `ownerRunIsOnTarget` guard is kept, with a comment, as defence if the planner's order changes.

## Evidence pointers

- Live: `GET /pool/placement?topic=10000001485` on the Studio answered `owner:null, reason:unowned` while this session ran. `logs/duplicate-reconciler.jsonl` at 2026-11-03T18:29:38Z: `escalated telegram:136774 rule2-rule3-contradiction`.
- Tests: `tests/unit/claimOwnershipOnSpawn.test.ts`, `tests/integration/sessions-spawn-claims-ownership.test.ts`, `tests/integration/pool-placement-transfer-routes.test.ts` (the target-run and leaving-run cases), `tests/e2e/ownership-follows-live-work-lifecycle.test.ts` (spawn route on dev and fleet configs).
