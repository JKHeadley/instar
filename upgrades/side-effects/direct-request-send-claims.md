# Direct Threadline send reservation

This dark checkpoint adds a SQLite reservation for one exact send per canonical owner message. The module has no runtime caller or installed migration.

- Authority. The reservation does not verify owner identity, pairing or the serving writer. Admission must establish those before using it.
- Over-block. A crash after reservation can leave a send unresolved. Existing reservations allow receipt lookup, so they never authorize another attempt.
- Under-block. Both the owner message reference and delivery ID are unique. Restart safety requires a crash-durable database and continuity of the original writer's history.
- Data. Only identifiers and the binding digest are stored. No message text is stored.
- Rollback. There are no installed tables or production effects to undo.

A reservation requires a top-level transaction. The module refuses an open caller transaction because releasing a savepoint would leave the reservation subject to rollback after transmission was authorized.

Independent review concurred after the nested-transaction refusal, exact delivery ID check and regression were added.
