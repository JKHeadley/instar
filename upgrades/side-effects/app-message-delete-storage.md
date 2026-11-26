# App message removal storage

## Authority and effect

The App journal recognizes a text-free removal fact for one exact occurrence. The lookup requires unique creation custody, a complete local index, and a matching original and fact read from journal bytes. The fact names both message and event IDs in that conversation. A wrong binding or author cannot hide the target or suppress a valid binding. Incomplete evidence yields an unknown result, which cannot authorize success.

The new index is derived and rebuilt from the existing journal. This checkpoint adds no app route, client capability, read suppression, attachment purge, replication input or provider action. A persisted fact is a storage primitive for later authorized use. Existing app reads, Stop, Forward and delivery paths continue to use their current projections.

## Side effects and interactions

Validation bounds IDs and constrains facts to native App conversation keys. Invalid IDs are rejected before persistence. A fact with an unproven custodian can be retained locally while the lookup waits for authoritative creation evidence. Duplicate frames have the existing event idempotency. A raw target survives a replay or index rebuild. The lookup double-checks identity rather than trusting an index locator.

## Multi-machine posture and rollback

The existing wire codec rejects this fact until admission, authorized sync and read freshness can ship together. No network emission or ingestion is enabled by this checkpoint. Dropping the derived index and rebuilding with a compatible version restores the same lookup. The raw journal stays under existing retention. A rollback of this checkpoint cannot remove an already visible app capability because there is no app entry point.

## 6b. Operator-surface quality

There is no user control in this checkpoint. The future confirmation names one selected occurrence and keeps the conversation and draft intact unless the server proves removal.

## Framework generality

Storage uses the existing App conversation journal and SQLite index. No harness or model behavior is involved.
