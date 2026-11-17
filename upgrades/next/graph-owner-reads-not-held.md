# Conversations answers right after a restart

<!-- bump: patch -->

## What Changed

After a restart, the Conversations pages (including Suggested efforts) could wait behind the agent's start-up checks for many minutes and end with "Your agent did not answer in time." A page that only reads is now answered from the conversation history that is already open, after a short wait of about 1.5 seconds. Saving a change still waits for every check. When the page truly cannot get an answer yet, it says so in plain words and tries again by itself every 15 seconds for about 5 minutes. The log now names the step the agent was busy with, and records "ready" after a restart.

## What to Tell Your User

- **Conversations after a restart**: "Right after I restart, the Conversations pages now load quickly. If my history is still opening, the page says so and keeps trying by itself; you don't need to tap anything."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversations reads answer during start-up | Automatic |
| Suggestions page retries by itself | Automatic |

## Evidence

Accept all round 3 (topic 144007): live page failed 15:13Z and 15:22Z on 2026-11-17 after the 14:55Z restart, recovered on its own at 15:25:55Z. Tests: `tests/integration/graph-default-boot.test.ts` (busy owner step), `tests/unit/console-conversations-dom.test.ts` (automatic retry).
