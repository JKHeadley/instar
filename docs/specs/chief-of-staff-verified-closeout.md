---
title: "Chief of Staff verified closeout and blocker intake"
slug: chief-of-staff-verified-closeout
eli16-overview: docs/specs/chief-of-staff-verified-closeout.eli16.md
approved: false
---

# Chief of Staff verified closeout and blocker intake

The Chief of Staff checks project progress against a finish checklist. It can already close a project whose automatic checks all pass. Some other check results turn into approval requests even when no owner decision has been established. This change makes automatic closure auditable and reversible, and sends unverified waits to the Chief of Staff for investigation. A confirmed owner decision still appears through the normal approval flow.

## Related work

| Area | Disposition | Reason |
| --- | --- | --- |
| Chief of Staff topic spec and project progression | Extend | The loop already verifies deterministic checklist items and records exact-binding closes. Harden that writer and expose its documented undo. |
| Work Board wait cards and Work Door project actions | Reuse | Preserve project visibility, explicit owner controls and existing card history. Keep coordinator withdrawals scoped to an exact wait episode. |
| Design Standards owner Needs-you rules (in progress) | Reuse | Design owns shared owner admission and exact withdrawal fencing. The Chief of Staff producer supplies workflow evidence and defaults to agent-owned. |
| Blocker Ledger and self-unblock checks | Extend | Add idempotent candidate intake by source episode under the ledger's existing mutation lock. Existing proof requirements govern escalation. |
| Existing owner PIN paths | Set aside | Owner finish and project rebinding continue to require the existing authentication. |

The seven-day claim check on November 25 found open PR #3783 on wait-card wording. Reuse its presentation rules and leave its copy changes to Design. Recently merged PR #3655 owns generated conversation origin and #3663 owns test timestamp ordering. Preserve both behaviors. Extend the Jobs and Projects open milestone for project progression. Reuse Design Standards’ active owner-admission work for the shared gate.

## Multi-machine posture

Close and undo use the existing replicated Chief of Staff journal. The serving coordinator serializes and fences both writes against current binding and lease, using the complete union for exact-close resolution. A peer with incomplete history holds the action. The blocker ledger currently persists locally. The replicated Chief of Staff journal retains the candidate identity and evidence needed for any new serving coordinator to reconstruct intake. Escalation must resolve the current source episode with the serving coordinator and preserve authorized owner requests through the shared gate. Review must confirm that failover can replay intake without exposing or replacing a separate owner approval.

## Frontloaded Decisions

A fresh deterministic pass permits automatic closure only within the confirmed evidence and lease rules. The current evaluator has no authoritative delegated judgment receipt. A checked judgment item is evidence for the separately authenticated Finish flow. A future accepted delegated receipt can extend automatic close once it carries current checklist identity and authority. An owner undo prevents automatic close on the same checklist. Evidence and lifecycle records stay inspectable after rollout or rollback. The eight existing rows receive exact-case reconciliation only.

## Owner admission contract

For raw Chief of Staff verdicts and their mirrored Work Board records, the source provider returns an `OwnerNeedsCandidate` with `responsibility: "agent"`, `actions: []`, and `handoffs: []`. A separate owner approval requires `responsibility: "owner-required"`, `ownerAction: "approve"`, one exact request or batch disclosure ID, a reviewed presentation template, and `verifiesCurrentOwnerRequest` for the current owner and request. The signed execution path owns authorization. A verdict, note, board lane, or blocker candidate does not confer approval authority. This branch owns the Chief of Staff producer and ledger intake. Design Standards owns the common route and migration.

## Acceptance

- The serving Chief of Staff uses its existing evidence evaluator against the current confirmed binding. Automatic close requires a nonempty checklist, all deterministic results passing on a fresh check, zero judgment items, and a current serving and check-in lease. Conversation claims and carried verdicts never authorize close. Revalidate the binding, pause, undo and lease at the authoritative write boundary. Record the exact binding and durable check reference for audit. Report completion and mirror the initiative only after a durable effective close.
- An authenticated owner can undo an exact agent close without rebinding or dismissing another request. The undo uses a binding- and close-specific lifecycle record. It restores the linked initiative and suppresses an automatic re-close on that binding until its checklist is revised or the owner explicitly finishes. Older lifecycle records still fold under their existing semantics.
- A raw waiting verdict, including a pending judgment item, enters the blocker ledger once per exact binding and wait episode. Use structured source identifiers and a display summary within the ledger’s configured text limit. Retain source references for the full evidence, mark shortened summaries, and require access to the complete evidence before an authority adjudicates owner responsibility. The ledger starts at candidate and uses its existing evidence and authorization checks. No owner-facing card or note is created from an unqualified verdict. If the ledger is unavailable, the project remains visible to the coordinator and the candidate retries. A legitimate owner-only blocker follows the shared Design admission policy. The change must preserve adjudicated owner holds.
- Verify both owner surfaces, durable close and undo, stale binding, stale lease, pause/reopen during evidence gathering, changed checklist, stale carried verdict, duplicate across restart, unavailable ledger and preservation of an adjudicated owner hold. Use unit, HTTP and production-composition lifecycle coverage. Keep the existing PIN tests.
- Roll back the producer and action wiring together. Keep existing journal and blocker records readable. Avoid any bulk decision on the eight reported rows. Reconcile each exact episode against current authority and evidence.


## Writer and recovery requirements

- Share the fenced coordinator writer with Design’s request withdrawal and owner finish. Gather evidence outside the lock. Inside the write boundary check current serving epoch, check-in lease, binding, pause and undo. The check and close use one accepted journal transaction or one record carrying both. Refuse when the writer cannot fence transfer or cannot prove its journal view current. Use a per-tick complete snapshot and indexed latest references, with the authoritative comparison at write time. Evidence used for close must meet the evaluator’s freshness limits at commit time.
- The owner invokes Undo on the completed project through the existing authenticated project action boundary. Bind the request to the exact binding and close identity. An exact replay returns the recorded result. A superseded close refuses. Automatic suppression survives unrelated binding changes by comparing the ordered checklist identity, including item kind and certification. Reconcile the linked initiative from the winning project fold on write and at startup, retrying mirror errors. An old close must never overwrite a newer undo’s active state.
- The first durable effective waiting check establishes the episode, scoped to its binding. Carry-forward verdicts preserve it. Unknown or unavailable evidence holds it without escalating. A fresh non-wait verdict, verified close, rebind or exact retirement ends the episode. Preserve the canonical episode and its disposition in the replicated source journal. Treat local ledger rows as coordinator projections and consult the current episode before processing them. After failover, reconstruct open candidates and completed or retired dispositions before admitting any owner action. Separate signed owner requests retain their own lifecycles.
- Remove unqualified owner calls to action in direct notes, derived Needs-you lines, wait card actions and flat projections. Keep the unresolved work visible in project history and the coordinator queue. Reconcile only exact auto-generated mirrors and preserve manual cards and independently authorized holds. Existing owner finish actions remain available in the project itself.

## Production wiring and activation order

The existing server wiring passes `ChiefOfStaffLoop` a direct `ReplicatedRecordEmitter.emit` adapter and a separate `awaitDurable` callback. The coherence journal assigns a sequence and queues the record before asynchronously flushing it. Neither the queue receipt nor a lease check before the queue provides a fenced durable decision. Do not use that adapter as the new close or undo authority. Keep the current path intact until the shared coordinator writer can provide both conditional acceptance and a durable receipt. Design owns the shared writer boundary. The closeout implementation consumes it from the Chief of Staff production composition and tests the real adapter with the gate off and on.

Test transfer in three windows: before acceptance, after enqueue and before durability, and after durability and before initiative reconciliation. The first two must never make an unfenced close effective. The third must replay reconciliation from the winning fold. Repeat with an owner finish or withdrawal racing the same project and with the prior holder's late record arriving after transfer. If the writer cannot prove these properties, automatic close and undo through the new path remain unavailable. The blocker candidate and owner admission changes do not depend on adding project mutation authority.

## Blocker intake implementation slice

Reuse the wait-card source ordering and effective pause/resume rules from `ChiefOfStaffWaitCards`. Its existing `waitStart` scan does not fence check events by binding and accepts a bounded journal tail, so it is insufficient as the replicated identity source on its own. New check events used for intake carry the binding reference that was evaluated. For old checks without a binding reference, obtain a fresh check for the current binding before opening a candidate. A reference to an old binding never becomes a candidate on a newer binding, even when its write arrives later.

Compose the intake port after the server constructs its existing `BlockerLedger`. Use the existing ledger instance and configuration gate. A disabled or unavailable ledger leaves the source visible to the coordinator, with delivery pending. It does not trigger a new owner ask. Pass the source episode key into a ledger mutation that checks and inserts under the same lock. A separate lookup followed by `open()` can duplicate the candidate. Persist the key on the row and retain the canonical disposition in the Chief of Staff journal. Use the full source records for adjudication and preserve the ledger's current validation and audit rules.

The first production test should drive a fresh bound check through the tick, capture the candidate under its source episode key, restart, and verify the same candidate is recovered. Then rebind while an old check is in flight and confirm no candidate opens for the old evidence. Repeat with the ledger unavailable and verify the coordinator retains the wait and both owner surfaces withhold it.

## Shared writer and prior-epoch frontier

Design supplies the exact ask identity `{project,bindingVersion,episode,requestVersion}` and the synchronous `appendOwnerNeedsDecision(leaseEpoch, prepare)` callback. The shared writer supplies the authenticated union and the write boundary. Each decision has a stable operation ID. The caller may retry an exact operation ID for reconciliation.

The prior writer must first stop admitting writes under its epoch and durably close its acknowledged journal prefix. The handoff proof binds store, agent, prior writer, prior epoch, terminal position and prefix digest. The new writer checks the proof against authoritative lease and membership history and verifies the exact prefix locally, including an explicit empty-prefix proof where applicable. A missing record, missing proof, digest mismatch, unknown writer or incomplete membership view yields unavailable. A closed prefix must include accepted operations even when their acknowledgment was lost. Abrupt failover requires an authoritative recovery path capable of proving that prefix. A grace period cannot stand in for that proof.

The writer runs `prepare` synchronously while holding the current mutation fence and supplies the certified union plus the current local prefix. A null result in that verified context means stale. Lease loss, an incomplete frontier or a missing current fence means unavailable. A prepared record receives a durable receipt only after the exact operation is verifiably recorded. When acknowledgment is uncertain, the writer retains the intent and resolves it against the verified operation history before granting success or admitting a competing decision. Reads that see an incomplete replica cannot clear a pending intent.

The shared coordinator layer owns proof and admission. Post-mortem supplies the journal's fenced append and durable lock semantics. Design supplies owner request identity and receipts. The conversation graph's native-tail barrier is a precedent for closing a signed prefix, with a separate journal scope here.

Acceptance requires a two-writer test. Writer A accepts a rebind and its replication is withheld. Writer B acquires the successor lease and gets through the grace tick, but an advance or withdrawal returns unavailable until the authenticated prefix is present. Once the predecessor prefix lands, the old ask is stale. A request for the new current binding can then obtain a durable receipt. Run an additional case with a lost append acknowledgment, proving the original operation is recovered without a duplicate.

### Frontier verifier inputs and negative cases

Verify three independent inputs before calling the decision builder: accepted predecessor identity from authoritative lease history, a seal from the journal authority after writer exclusion, and the authenticated prefix for the seal's exact stream incarnation. A verified lease transition establishes who preceded the current writer. The seal establishes the final accepted position. The prefix establishes which records reached this machine. None of those facts can be substituted for another. The Git-backed lease registry is a candidate predecessor identity source. A local replace-in-place lease file cannot supply that history by itself.

The lifecycle fixture now withholds the prior writer's durable checklist update and demonstrates that the successor's peer reader reports complete on both sides of delivery. Extend this fixture at the writer boundary. Cover a missing terminal row, a missing interior row, wrong stream incarnation, digest mismatch, and a seal from the wrong predecessor epoch. Each case must return unavailable and leave the decision builder uncalled. Once the right prefix arrives, the old checklist must return stale, and an exact operation against the new checklist may proceed. A retained uncertain intent must continue to block an opposing decision after takeover. Exercise the legacy writer through its installed direct entry point when proving exclusion.
