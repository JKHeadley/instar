---
title: Suggestion decisions on every machine
---
The owner's Reject, Accept and started Accept on a Conversations suggestion reach every machine of the agent, so a rejected group never comes back on another machine and an Accept started on one machine shows Continue on the others and continues the same group. The suggestion list itself is built on each machine. It is on wherever the coherence journal runs; the off switch is `multiMachine.stateSync.conversationGraphSuggestions.enabled: false`. A machine on an older build keeps its decisions to itself until it updates.
