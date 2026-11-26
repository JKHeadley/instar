# Side-Effects Review for First Local History Copy Permit Persistence

This isolated recorder persists a first permit and consumes an exact prepared operation in the caller's jobs transaction. It is currently uncalled by staging and does not send a worker message.

## Over-block

Invalid bounded fields, malformed schema, a non-FULL or non-rollback-journal connection, a stale operation or preview index, a conflicting replay, and a full recorder fail closed. The row cap includes retained records and there is no retirement path in this checkpoint.

## Under-block

The recorder compares persisted state with the supplied bounded facts. It does not authenticate an owner or child, observe wall or monotonic expiry, or verify reservation, writer ownership, live gates or content bytes. The actual coordinator must enforce those checks and use its existing immediate transaction. Before physical copy it must commit the transaction and send at most one exact issued slot.

## Abstraction fit and interactions

The separate strict table uses one row per operation. The conditional phase change and insertion share a nested savepoint within the caller's active transaction. A caught insertion failure cannot commit the phase change alone. Rollback of the caller's transaction also rolls back the slot. Replay reports that a matching request was already recorded and cannot update it. Jobs and disk-ledger databases remain separate.

## Signal versus authority

Under docs/signal-vs-authority.md, phase, generation tag, expiry snapshot and preview allocation digest are exact persistence facts. The bounded first slot represents a record for integration and does not issue a mutation permit or authorize delivery.

## External surfaces and machine scope

There is no route, worker, initialization call, new user control, installation migration or external I/O. The recorder is local to the selected target and does not store a raw challenge or conversation payload.

## Rollback

The code can be reverted before integration. Its synthetic test databases are owned fixtures. A future integrated rollback must reconcile any actual issued records before removing support for the table.

## Evidence

Focused real SQLite tests cover rollback, exact preview index mismatch, reopen after commit, replay, and malformed schema.

## Independent Review

The reviewer concurred with the transaction and replay boundary. The live caller must use the actual staging jobs connection and its validated upload operation and preview schemas. The reviewer inspected the source and tests without running them.
