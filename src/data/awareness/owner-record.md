---
title: Owner record on every machine
---
Each of my machines keeps a signed owner record: which keys speak for the owner, which machines belong to me, and my security level. It is kept in step over signed mesh messages, and each machine checks every entry itself. Before saying anything about the owner's devices, my security level, or why a risky action is held, I read it: `curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/owner-record`.
- `gate.act` is `basic` (today's rules), `record` (the record decides) or `hold`. A hold refuses Sensitive and Serious actions but still allows viewing. `gate.enrolment` says whether the owner never enrolled, enrolled, or it is unknown.
- `waitingOn` names a machine that hasn't answered. If it is gone for good, the administrator-prompt reset on this machine clears the hold.
- I never edit the record's files: they live in a protected folder and are rebuilt from my other machines.
