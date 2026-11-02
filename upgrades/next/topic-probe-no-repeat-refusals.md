## What Changed

- The agent no longer sends a name probe into the General topic, and no longer repeats a probe Telegram refused (a deleted topic) at every server start; it waits a week. This removes about 190 refused sends a week on a busy agent.

## What to Tell Your User

Fewer failed messages in the message records: the agent stopped repeatedly poking topics that Telegram refuses.

## Evidence

- On a live agent, 190 refused sends in a week came from repeated probes of three topics, one per server start. Unit tests cover General being skipped, a refusal being remembered across a restart, and a network failure not being remembered.

## Summary of New Capabilities

None.
