---
title: Conversations owned by a machine that left the pool
---
When a machine is wiped, replaced or removed, the conversations it owned move by themselves to the machine in charge (the lease holder): a revoked owner at once, an owner missing from this machine's registry once its activity log has been silent for six hours. A message in such a conversation is answered on the machine in charge instead of waiting forever, and moving the conversation by hand with `POST /pool/transfer` works and reports `seatMoved: true`. To check where a conversation lives read `curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/pool/placement?topic=N"`; the stale-owner decision log is `logs/stale-owner-release.jsonl` (claims carry `unroutable-owner:<reason>`).
