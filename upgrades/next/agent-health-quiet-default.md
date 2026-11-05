<!-- bump: patch -->

## What Changed

Routine Agent Health reports now stay in the attention record without sending Telegram messages. A report explicitly marked as needing the person can still reach the Agent Health topic. HTML formatting now survives a standby machine's relay to the Telegram holder.

## What to Tell Your User

Agent Health is quieter: I keep my own machine and session reports in the record, and message you only when I need you to act.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Quiet Agent Health record | View attention items in the dashboard; actionable reports still arrive in Telegram. |

## Evidence

A regression test failed before the change because a routine Agent Health observation created a Telegram topic and message. After the change, focused attention routing, standby relay, and system topic tests pass. The full notification-selectivity gate remains tracked under #2738 <!-- tracked: 2738 --> (the existing spec also names CMT-1948).
