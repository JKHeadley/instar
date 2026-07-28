# ELI16 — Replicated Witness Index

## What Changed

Replicated stores write their updates into append-only journal files. When one machine writes a new record, it also stamps an `observed` witness: the newest version of that same record key that this machine had already seen. That witness is what keeps two machines from silently overwriting each other when they edited the same thing at the same time.

Before this change, the witness lookup was correct but expensive. Every emitted replicated record asked the peer-stream reader to find the latest witness for one `(store, recordKey)`, and the reader answered by scanning the journal streams again. On a small journal that was fine. On a real evolution-action journal with tens of megabytes and many keys, every surviving emit still paid a synchronous journal scan.

This change keeps the journal as the source of truth but adds a derived in-memory witness index. When the reader attaches, it streams the journal files once in fixed-size chunks and builds a map from `(store, recordKey)` to the latest HLC witness. After that, `loadWitness()` reads the map directly instead of re-reading the journal. When the local journal or peer applier durably commits replicated records, they notify the reader after `fdatasync`, and the reader updates the map incrementally.

## Why It Is Safe

The index is derived and rebuildable. It is never more authoritative than the journal. A restart, missing index, or lost in-memory state simply rebuilds the map from the journal streams. The update hooks run only after durable append boundaries: local records after the journal flush has written and synced the batch, and peer records after the applier has written and synced the replica batch.

The rollout also keeps a parity check. During rebuild, the derived map is compared with the legacy full-scan witness answer. If the answers ever disagree, the reader logs a loud warning and falls back to the legacy scan instead of trusting the index.

## How To Verify

The unit tests prove the index matches the legacy answer across local writes, peer writes, and later updates. They also prove an emitter using `loadWitness()` does not read journal bytes once the index is built. The integration test covers the real emitter path with a counted filesystem seam. The e2e lifecycle test proves a fresh reader rebuilds the witness from own and peer journal streams after the in-memory index is gone.
