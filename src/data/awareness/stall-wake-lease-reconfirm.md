---
title: A machine back from a stall re-asks before taking the lead
---
When `multiMachine.takeoverReadyPool.stallReconfirm.enabled` is true, a machine that lost a large share of a lease lifetime of running time (a sleep, or a heavy build starving its server) does not take the lead from a lease that only looks expired because it was not running: it pulls the holder's lease first and claims only after a full lease lifetime has passed awake with a fresh round of pulls finished, so a live holder's renewal always arrives first. The server log shows each step as `stall-reconfirm: ...` lines. It is off unless set; read the log before saying why a machine did or did not take the lead after a stall.
