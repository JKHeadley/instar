# Private App Delete sync cursor codec

The server can authenticate a cursor against its paired device, reader, conversation, custodian, visibility epoch and exact position. A former epoch cannot resume, and malformed or foreign cursors are rejected. Neither rejection exposes a position as an authenticated result.

This checkpoint mounts no route. Production must supply current authorization evidence and use one shared codec instance across history and sync. Clients must cover cached rows on invalidation and check an incoming page's epoch when merging it.

## 6b. Operator-surface quality

A client can detect that its saved sync position no longer matches the current reader and recheck cached rows before showing them.

## Framework generality

The cursor contract is independent of the device client and agent harness.
