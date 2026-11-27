---
title: Local Verify peer and queue capacity
---
The coordinator can use up to three remote verifiers, with one run per machine.
Read `GET /local-verify` to see the configured peers and their reservations.
The coordinator reads `monitoring.localVerify.queueCap` live. It accepts integers
from 10 through 30 and defaults to 10. An invalid setting falls back to 10 and
leaves an `invalid-queue-cap` audit entry. Lowering the cap lets admitted work
drain before new changes can enter.
