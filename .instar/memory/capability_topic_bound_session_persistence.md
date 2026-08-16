---
name: Topic-Bound Session Persistence
description: Telegram/Slack/iMessage agents stay resident for 4 hours during conversation pauses (upgraded from 15 minutes)
type: user
---

## Overview

Sessions bound to a live Telegram, Slack, or iMessage topic now stay resident for up to 4 hours of idle prompt time instead of being killed after 15 minutes. This eliminates respawn delays when the user steps away and returns to an active conversation.

## How It Works

SessionManager's zombie-killer used to treat "idle at prompt + no active processes for 15 minutes" as a zombie state and kill it unconditionally. For messaging-bridged agents, this is actually the *healthy* waiting state — the agent sits at the prompt waiting for the next user message.

The updated logic:
- **Topic-bound sessions** (Telegram/Slack/iMessage) use a longer idle threshold: 4 hours (configurable via `idlePromptKillMinutesBoundToTopic` in `.instar/config.json`)
- **Unbound sessions** still respect the original 15-minute threshold
- This only affects messaging-bridged agents; other agent types are unchanged

## Practical Effect

When you message Echo after stepping away for an hour (or even 3.9 hours), the response comes immediately without a respawn cycle. Previously, you'd see a 5-minute respawn delay and might get a "session appears stuck" error.

## Configuration

If you want to adjust the idle timeout for topic-bound sessions:

```json
{
  "idlePromptKillMinutesBoundToTopic": 240
}
```

Default is 240 minutes (4 hours). Increase for longer pauses, decrease to free memory faster on constrained hardware.

## Trade-offs

- **Benefit**: Seamless experience when resuming long-idle conversations
- **Cost**: Extra memory consumption during idle windows. On a memory-constrained host with 8+ active conversations, could add a few GB during quiet periods.
