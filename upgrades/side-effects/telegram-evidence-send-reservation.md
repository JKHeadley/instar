# Telegram evidence and one-use reservation

The dormant reservation reparses the original polling message, requires exact source, digest, recipient and message equality, and checks the committed evidence row inside the same immediate transaction that reserves a single attempt. Evidence conflicts committed before reservation cause refusal. A later conflict prevents new reservations and does not undo an attempt already reserved.

- Authority. The caller still establishes the current authenticated bot and owner, serving writer, accepted pairing and allowed thread. The patch has no live caller.
- Retry. An exact existing reservation can only lead to receipt lookup, subject to the current evidence check.
- Rollback. No deployed configuration, migration or production data changes.

Independent review concurred. The focused test also exercises a duplicate delivery ID across two otherwise valid captured sources.
