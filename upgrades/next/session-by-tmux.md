<!-- bump: patch -->

## What Changed

A session's tmux name is reused when a conversation returns to a machine, and lookups by name could pick an old finished record instead of the live session. When a conversation moved away, that could leave the live session running on the machine it had left. Every lookup by name now picks the live session.

## What to Tell Your User

Nothing to do. On an agent with several machines, a conversation that moves back and forth no longer leaves a stray copy behind.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Lookups by session name find the live session | automatic |
