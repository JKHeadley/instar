# Side-effects review for project wait blocker intake

This draft adds candidate intake behind `chiefOfStaff.waitBlockerIntake`, default off. The opt-in also requires the existing blocker ledger. Current installation defaults require no migration.

- Over-block and under-block. The code makes no authorization decision. Missing history or holder status prevents the candidate write. Existing owner notices remain in place.
- Abstraction and authority. The Chief of Staff loop projects exact journal references into the existing blocker ledger. A candidate records a signal and does not represent an owner decision. The ledger serializes creation and checks the source identity on retry.
- Interactions. The active coordinator skips the first tick after takeover. A local restart reuses an existing candidate. The active process skips repeat writes while the same wait remains visible.
- External surfaces. No route or message was added. When enabled, internal candidates appear through existing authenticated ledger reads.
- Rollback. Leave the switch unset or disable it. This stops intake. Candidates written by a trial remain as audit evidence.
- Activation blockers. Require a fresh check after legacy data or a rebind. Enforce current replicated episode and disposition before a candidate can advance or settle. Verify takeover and the owner projections before enabling this on a real agent.

Independent review concurred with committing a default-off draft. The review raised stale candidate authority, legacy check carry-forward, and redundant ledger writes. The switch remains off, the first two findings remain activation blockers, and repeated writes from a continuously visible episode are suppressed.

## Current episode follow-up

An opted-in ledger verifies the exact current wait before changing a Chief of Staff candidate, including at commit after a settlement review. The mutation read flushes queued local changes and refuses when the queue remains pending. Normal ledger entries keep their existing workflow. A verdict from a different or unrecorded binding cannot carry forward while intake is enabled.

Independent review concurred with the default-off draft and identified a queued-rebind race, delayed peer updates, and a legacy verdict that an earlier build may have carried forward under a binding before intake was enabled. The queued-rebind case has a server regression test. Cross-machine freshness and verification of previously carried legacy verdicts remain activation blockers.

## Off-to-on evidence and delayed peer records

A wait check carries explicit evidence lineage only after an opted-in check has evaluated the current binding or carried forward a check with that same established lineage. The selector requires this lineage for its opening and latest observation. A current-binding record copied forward from the previous implementation does not qualify. The regression first records a carry while intake is off, enables intake, and verifies the candidate references the new evaluation.

Peer stream completeness establishes that the files already present were read without truncation. It cannot establish that a peer has delivered its latest binding change. A takeover grace tick is also insufficient under arbitrary delay. The shared writer needs a currentness receipt covering the remote authority's write frontier, or it must refuse before candidate mutation. Keep production activation off until that boundary is supplied and tested with an actual delayed update.

Independent review concurred with the default-off legacy lineage change. It also found that a display note could match the carry-forward wording. The journal now records fresh and carried evidence explicitly. The selector reads that field, and the regression includes a fresh check whose note matches the old wording.

## Successor frontier slice

The assessor compares predecessor identity, seal identity and terminal position and digest from an authenticated journal reader. Missing or mismatched inputs are unavailable. A retained uncertain operation is pending. Production has no seal provider. It refuses to mutate a Chief of Staff blocker while that provider is absent. This slice does not claim to authenticate a seal, compute a journal digest, exclude an old binary or recover an uncertain write.

Tests cover missing and mismatched inputs, a retained uncertain append, absence of the production frontier, and the two-machine delayed-rebind baseline. The lifecycle fixture supplies currentness only to exercise the existing local rebind behavior. Activation requires certificate production, verified prefix continuity and a fenced check-and-write spanning the journal and decision.

Independent review concurred with the default-off slice and identified the risk of fetching the seal verdict and decision records separately. The mutation port accepts only a union supplied from one verified snapshot. No production implementation is installed. The eventual writer must bind the snapshot to the current mutation fence.

## Successor manifest consumer

The consumer checks the current generation, manifest digest, successor writer, epoch and incarnation against one supplied snapshot. It calls the decision builder only after the predecessor prefix verifies and has no unresolved intent. The result can report unavailable, pending, stale or prepared. Preparing a record does not append it or certify durability. There is no production caller.

Independent second pass concurred with the dark slice. The two-machine fixture uses actual journal replication with a simulated authority and digest. It demonstrates refusal during delayed delivery and for stale authority, then distinguishes an old request from a new one after delivery. Production still requires verification of canonical bytes, a real current-generation authority, and commit-time fencing of the same snapshot.
