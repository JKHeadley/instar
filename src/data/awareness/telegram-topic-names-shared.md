---
title: Telegram topic names on every machine
requires: telegram
---
Telegram topic names and renames reach every machine of the agent within minutes, even though only the lead machine listens to Telegram, and they survive that machine dying: every machine that receives a name keeps a copy and passes it on. A rename always beats an older name; a name a machine held from before only fills a blank, never replaces another machine's name. It is on wherever the coherence journal runs; the off switch is `multiMachine.stateSync.telegramTopicNames.enabled: false`. When a conversation shows no name on one machine, check that machine's journal replication before renaming by hand.
