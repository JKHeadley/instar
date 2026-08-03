# Side-effect review — inbound queue shadow custody

## Changed boundary

Dry-run still returns `refused` and therefore preserves the existing local
fall-through path. Before returning, it now runs the real enqueue transaction
against `pending-inbound-shadow.<agent>.sqlite`, reads the row back exactly,
records evidence in the authoritative store's meta counters, and scrubs the
shadow row. The shadow store has no drain path and cannot acknowledge custody.

## Expected effects

- One additional FULL-sync SQLite transaction per inbound message while the
  queue is explicitly enabled in dry-run.
- The live queue's entry table stays empty; only durable evidence counters and
  timestamps are added to its existing meta table.
- Payload bytes exist briefly in the shadow WAL/store under mode 0600, then are
  nulled and pruned with SQLite secure-delete plus a truncating WAL checkpoint.
- A process crash after shadow commit can leave a row. Construction recognizes
  it as recovered persistence evidence, terminalizes and prunes it, and never
  sends it to the drain.
- Live mode opens no shadow store and performs no shadow writes.

## Compatibility and migration

All API changes are additive. `custodyDurability` remains `unknown` for existing
consumers; `custodyDurabilityDetectionAvailable: false` supplies the missing
provenance. New tenures persist `tenureStartedAt`. A tenure created by an older
build returns `null` until a real holder change starts a newly observable tenure;
the migration deliberately does not fabricate a timestamp.

The counters are not actually tenure-scoped in the implementation: they persist
for the store lifetime and are never reset by `observeLeaseClaim`. The additive
`countersScope: store-lifetime` field makes that source fact explicit instead of
letting proximity to `tenure` imply a reset boundary that does not exist.

The shadow database uses a distinct resolver and filename, so no migration can
make its rows authoritative. It is created lazily only in enabled dry-run.

## Failure behavior

A shadow-store open or transaction failure never changes message delivery: the
dry-run remains fail-open, `shadowCustody.available`/error evidence exposes the
failure, and `dryRunErrors` increments. Cleanup failure leaves the isolated row
for the next boot recovery pass.

## Decision audit

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Custody exercise | Same store implementation, separate DB | Insert into the live queue | Exercises the real schema and sync settings without creating dispatchable custody |
| Proof lifecycle | Commit → exact read-back → evidence → scrub | Keep shadow rows for inspection | Durable counters retain proof without retaining message content |
| Crash gap | Recover as evidence, then scrub | Ignore or dispatch | A committed shadow row proves persistence but has never accepted delivery authority |
| Durability status | Add detection-availability sibling | Rename/remove `custodyDurability` | Makes the placeholder explicit without breaking existing consumers |
| Legacy tenure start | Return `null` | Backfill with upgrade/boot time | A fabricated timestamp would make the current tenure look younger than it is |

## Class-closure declaration

This closes the “surface carries less than the source knows” instance at three
seams: dry-run decisions gain storage evidence, placeholder status gains explicit
measurement provenance, and cumulative tenure context gains a time anchor. Route
tests pin all three at the consumer boundary.
