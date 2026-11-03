## What Changed

Prompt Gate relayed every session prompt to Telegram the moment it saw one, even prompts that something else answered seconds later (an account swap after a usage limit, the permission-prompt floor, a respawn). The first relay in a topic also sent a separate "Prompt Gate is now active" message.

- A detected prompt now waits a short settle window (`promptGate.relaySettleMs`, default 45000 ms), then the live pane is read again. The prompt is relayed only if it is still on screen. A session that is gone, or a pane that no longer shows the prompt, means no message. An unreadable pane still relays.
- The one-time privacy note now rides on the first relayed prompt as a single line instead of arriving as its own message.
- `relaySettleMs: 0` restores the old immediate relay.

## What to Tell Your User

You'll stop getting "your agent needs confirmation" messages for prompts that were already handled automatically. A prompt that really needs you arrives about 45 seconds after it appears.

## Evidence

Unit tests cover both sides of the decision (still on screen → relay; cleared, session gone → no relay; unreadable pane, nothing to match → relay; 0 disables the wait) plus wiring checks on the server relay path. Existing Prompt Gate tests pass.

## Summary of New Capabilities

None. One new optional setting: `promptGate.relaySettleMs`.
