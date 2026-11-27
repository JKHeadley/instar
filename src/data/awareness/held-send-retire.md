---
title: Held and restart-parked replies
requires: telegram
---
A reply written while the server was restarting is now sent once the server is ready. A held or restart-parked reply that has waited more than 30 minutes is not sent automatically: it comes back to the session that wrote it as one line with its operation id, and that session decides whether it is still right to resend (`GET /telegram/origins/operations/<id>/text` returns the recorded text). To stop one held reply on this machine, for example when the operator says it should not go out, retire it by id with a short reason. The route only ever stops a send, answers 409 when the reply may already be on its way, and records who retired it.

```bash
curl -s -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
  http://localhost:{{port}}/telegram/origins/operations/OPERATION_ID/retire -d '{"note":"operator: no longer needed"}'
```
