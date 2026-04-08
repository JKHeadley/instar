# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **Topic cleanup no longer closes explicitly-configured topics**: The startup topic cleanup was closing forum topics for on-alert and silent jobs even when those topics were explicitly configured in jobs.json or shared with other active jobs. Now only dynamically-created topic mappings are cleaned up, and only if no other job references the same topic.

## What to Tell Your User

- **"Your Telegram forum topics should stay open now"**: If your user noticed that certain Telegram topics kept getting closed after server restarts, that should be resolved. The system was incorrectly treating explicitly-configured topics as stale.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Safe topic cleanup | Automatic — explicitly-configured topics are preserved on restart |
