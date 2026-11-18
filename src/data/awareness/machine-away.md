---
title: Why another machine is away
---
When one of the agent's machines shuts down on purpose, it tells the others why (restarting the machine, restarting its server, or stopping) and when it expects to be back, so the pool shows `offline` with that reason instead of a bare "unreachable". Read it with `curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/pool`. If a machine said it would be back and has not returned 10 minutes past that time, the pool says so. A machine that vanished without announcing still reads as unreachable. When a session asks "why is the M5 gone?", read the pool before guessing.
