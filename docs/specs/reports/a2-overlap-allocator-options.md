# Who decides when two scopes claim the same records?

**Decision requested.** Start with one existing owner for each independently provable record domain. Give that owner one durable place to accept both new scopes and splits of existing scopes. Hold any domain that cannot prove safe writer handover. Keep consensus as a separate upgrade for domains that must stay available through a machine loss.

A new scope and a split can each pass their own preliminary checks, then claim the same record. The decision belongs at the transaction that activates ownership. A later operation needs a second protection at its accepting write or gateway because a check can go stale while a worker is paused.

| Option | How it works | What it costs |
| --- | --- | --- |
| One allocator per existing record domain **(recommended)** | Use the existing record owner and its durable journal or transaction. Bootstrap and split contend on the same authoritative coverage for the affected records. Keep domains separate only where their facts cannot overlap. Activate a successor only after the enrolled custody protocol proves that old writers are fenced and the required final state is durable. | A disconnected owner pauses scope changes. Failover needs positive custody and fencing evidence. Each enrolled domain must define how overlap is detected. No separate fleet-wide registry or consensus service is needed for the first domain. |
| A replicated allocator | Put the same ownership decision in a consensus-backed log. Every bootstrap and split in an overlapping domain commits against one ordered log. Have the write and effect boundaries enforce the committed authority epoch. | A surviving quorum can accept decisions after a machine loss. This adds quorum availability, authenticated membership, snapshot recovery and replacement costs. Consensus over allocation alone still cannot fence a gateway that accepts stale authority. |
| Fixed domains, with no online splits | Preassign disjoint coverage and allow only new scopes inside their existing owner's boundary. Make splits an explicit maintenance operation with writes stopped and old authority fenced before reopening. | Small online surface and straightforward recovery evidence. Splits take an outage and operator time, and arbitrary cross-boundary changes remain unavailable. This is a fallback for a domain that cannot yet meet the first option's handover conditions. |

## First proof for the recommended option

1. Pick a domain where the owner can check overlap against the same durable state that accepts ownership. Send a bootstrap and a split from separate writer connections. Let both finish preliminary validation before releasing them to commit. Show that only one can authorize writes for the intersecting records, including after restart or a lost reply. A disjoint request should succeed.
2. Pause an operation after it verifies the old owner. Activate the successor. Resume at the ordinary mutation or last controllable effect boundary. Show that the old installation is refused and a new request using current proof can apply once. Include an operation already accepted before handover and prove its result survives once.
3. Isolate a previously authorized writer and repeat the handover attempt. If that writer can still accept changes or its final accepted state is unknown, the proposed successor must stay inactive. Verify the positive transition with the real enrolled custody boundary before enabling machine failover.

The graph witness shows the transaction pattern in `src/core/GraphWitnessService.ts`. It validates writer authority and records the accepted evidence together for graph writes. The A2 work-start spec already calls for a current owner check and for permit validation at the actual effect gateway. Those are precedents for the first proof. This draft proposes a protocol choice and does not grant runtime authority or amend the constitution.

## Decision and first evidence

Chief of Staff selected the per-domain owner option on November 24, 2026. The decision is recorded in the A2 work-start spec. The focused SQLite cases are in `tests/unit/a2-overlap-allocator-proof.test.ts`. They use disposable local storage and separate connections. They qualify the executable contract only. An actual pool handover and connector require separate proof through the enrolled owner.

All three focused cases passed. A controlled weakening of each guard caused the corresponding assertion to fail. The overlap check includes each winner order and reopens the owner after a deliberately dropped response. The isolated-writer check keeps the successor inactive after sealing until the fixture carries the writer's last accepted state.

The existing GraphWitness owner now has a focused failover regression. An operation prepares successfully under the old writer, the successor adopts it, and the witness is reopened. The old writer submits signed receipts before the successor can certify anything. The witness rejects that commit and preserves the pending state. The successor then certifies once, and its retry returns the same certificate. This is evidence for an existing graph writer lease, with scope allocation and external dispatch still outside that proof.
