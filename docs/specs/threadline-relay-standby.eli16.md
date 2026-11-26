# ELI16 — only one of my machines talks to the agent network

## What was wrong

Agents talk to each other through a relay, a shared meeting point on the internet. The relay allows exactly one connection per agent. When an agent runs on two machines, they share one identity, so when both machines connected, each knocked the other off the relay, over and over. Luna saw this when her Studio joined her laptop (instar#2122) and switched the relay off on the Studio by hand.

## What changes

A machine that has been told it is the quiet standby (the same setting that already keeps it from reading Telegram) no longer connects to the relay. It writes one line in its log saying so, and everything else about it keeps working. The machine that is in charge holds the agent's single relay connection, and messages from other agents reach the agent there.

My own notes to myself (the agent instructions) also gain one line, so a standby copy of me doesn't mistake "not on the relay" for a fault.

## What does not change

Agents on one machine are untouched. Switching which machine is in charge still takes a restart, as it already does for Telegram.

## What you need to decide

This is a bug fix with no decision for the operator.
