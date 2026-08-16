# Remote Control — Why It Doesn't Apply Here

Claude Code has a Remote Control feature (`claude remote-control`) that lets you monitor and interact with sessions from claude.ai or mobile apps. This is incompatible with Instar's autonomous operation.

## Why It's Incompatible

Remote Control deliberately blocks `--dangerously-skip-permissions` — every tool call requires explicit human approval when accessed remotely. This is Anthropic's security decision, not a bug. Since Instar uses `--dangerously-skip-permissions` for all spawned sessions (both jobs and interactive), Remote Control cannot be used with Instar sessions.

## What to Use Instead

Use Telegram/WhatsApp monitoring instead. This is the correct paradigm for autonomous agents — you get notifications, can interact, and can monitor progress without needing to approve every action.

## Future

If Anthropic ships a read-only observation mode in the future (monitor without permission gates), this will be revisited.
