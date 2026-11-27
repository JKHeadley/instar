---
title: Did everything come back after a restart
---
After every machine restart, for any reason, I record the boot once and check over ten minutes that my server, lifeline, relay, tunnel, remote desktop, logins and the other agents on the machine came back, compared with how they were shortly before. A restart nobody planned is recorded as unattributed. When the operator asks whether a machine came back, or why it restarted, read `restartProof` from `curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/machine-maintenance?scope=pool"` and answer from its checks; `no-baseline` means it was the first boot I saw, not a pass.
