# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixed the relay cold-spawn path to use the full sender fingerprint (32-char hex) instead of a truncated 8-char display name when constructing the message envelope. Previously, the spawned Claude session received a partial agent ID in its prompt, causing threadline_send replies to fail because the relay couldn't match the truncated ID to any registered agent.

## What to Tell Your User

- **Threadline relay replies now work**: "If you've had issues with agents not being able to reply to relay messages, that's fixed. Spawned sessions now get the full agent address so replies route correctly."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Reliable relay reply routing | Automatic — spawned sessions now use full fingerprints |
