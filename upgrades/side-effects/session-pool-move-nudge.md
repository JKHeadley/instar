# Side effects: session-pool-move-nudge

**Change.** After a move's claim lands, the source tells every other active machine to pull placements from it now, through a new signed mesh verb `ownership-nudge`. The receiver pulls one kind from that sender, runs the ownership applier once, and wakes queued messages for any key that reached the claim's epoch. Spec: `docs/specs/session-pool-move-nudge.md`.

**Why.** A new owner learned of a move only by pull: measured 28 s to 3 min 14 s on Echo's ring. A message waited, safely, and a following move could refuse for lag.

**Reach.** Only machines with `coherenceJournal.replication.enabled`. Without it the sender's binding is null and sends nothing, and a receiver records an `off` row and does no work. Single-machine and default agents are untouched. Moves through the pin arm of `POST /pool/transfer` send no nudge and behave as today.

**Over-block and under-block.** This gates nothing. Router, existing RBAC and the applier's fast-forward rule are unchanged. The verb joins the registered-peer class, so `verifyEnvelope` has already proved an active signed sibling. An unknown machine is refused before any work. It carries no owner and writes nothing from its payload.

**A wake is not free, which is why it is conditional.** Waking a queued message clears its backoff, and a retry against a stale view spends its attempts. So a key is woken only once its local epoch has reached the nudge's. A test pins both sides of that.

**Load.** One placement pull per second per sender at most, 60 passes per sender per hour, 5 failed passes in a row stops that sender for 5 minutes, 100 pending keys. A pass only ever starts from a nudge, so no moves means no work. Each stop writes an evidence row. Overlap with the 30 s pull is safe: `apply` is synchronous and drops entries at or below the held sequence, and `tick` is synchronous.

**Failure.** A lost nudge, an older peer (refuses with `claim-unauthorized`), or a brake gives today's behaviour: the 30 s pull and the 15 s applier, both unchanged. A receiver more than 3 pages behind reads not reached and the normal pull finishes.

**Agent-installed change.** One CLAUDE.md line, on template and through `migrateClaudeMd` with a content-sniffed marker, naming `logs/feature-evidence.jsonl` for why a message waited.

**Rollback.** Revert the release. Mixed versions behave as today in both directions.

**Not proved here.** The live pass line, under 10 s on every ring leg, runs only after release on Echo's machines. Tests use the real mesh with a stand-in journal and applier on the two ends; the integration test does not boot two full servers.
