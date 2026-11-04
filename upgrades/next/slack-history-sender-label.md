<!-- bump: patch -->

## What Changed

The Slack thread history injected into a session now labels each message with its own sender. Before, every non-bot line carried the current message's sender name, so in a shared thread one person's message read as another's (seen live: two people, one thread, the agent reported both lines under one user ID). The bot's lines read "Agent", the current sender's own lines keep their display name, and other people appear by their own Slack user ID. Single-person conversations read as before. A new helper, slackHistoryLabel, holds the rule.

## What to Tell Your User

In a Slack thread with several people, I now see who wrote each earlier message. Before, I could mix up who said what.

## Summary of New Capabilities

- Correct per-person attribution of Slack thread history in shared threads.

## Evidence

Six unit cases cover the shared-thread case, a three-person thread and the single-person case. The live failure was captured on a fresh test agent with two real Slack people (topic 136880, 2026-11-04).
