<!-- bump: patch -->

## What Changed

Inbound-queue dry-run now proves that its custody transaction can commit and be
read back from disk. It uses a separate, non-dispatchable SQLite store, records
durable success/refusal/error evidence, and immediately scrubs the shadow row.
The queue status also says plainly that durability detection is not implemented
yet, records `tenureStartedAt`, and names the counters' actual store-lifetime
scope so adjacency no longer implies that they reset with tenure.

## What to Tell Your User

- **Dry-run now tests storage, not only routing decisions:** “The inbound queue’s rehearsal now writes each candidate to an isolated on-disk queue, verifies it, and removes it without affecting delivery.”
- **Unknown durability is no longer ambiguous:** “The status says when durability detection is unavailable, so ‘unknown’ cannot be mistaken for a measurement.”

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Inspect dry-run custody proof | Read `shadowCustody` from `GET /pool/queue` |
| Distinguish placeholder from measurement | Read `custodyDurabilityDetectionAvailable` beside `custodyDurability` |
| Interpret the current tenure's age | Read `tenureStartedAt` beside `tenure` |
| See the counters' actual reset boundary | Read `countersScope` (`store-lifetime`) |

## Evidence

Focused store, policy-engine, and real-route tests prove shadow commit/read-back,
policy refusal, crash recovery without dispatch, payload cleanup, distinct live
and shadow stores, tenure timestamp persistence, and the explicit API fields.
