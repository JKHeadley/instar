# The outbound check knows what the agent can already reach

## What Changed

The outbound check's false-blocker rule (B17) now sees what the agent can already reach whenever a reply asks the operator to look at, check, open or send something. It gets the accounts signed in to this machine's browser profiles and what the agent's own key reads (everything the dashboard and app show). If that reach plainly covers the errand, the reply is stopped and the agent is told to do it itself and mark anything it sends as the operator. Taste questions, secrets, unlisted accounts and real messages to third parties still pass. The extra rule text appears only when the errand signal fires, so every other message is checked as before.

The session-start browser-profile list was capped at 800 bytes, which hid most profiles on a machine with many of them. The cap is now 2400 bytes, and the list says to use these accounts before asking the operator.

## What to Tell Your User

I'll stop asking you to check things I can see or do myself. If my browser is signed in to an account, or the dashboard shows it, I'll go look myself and tell you what I found. Anything I send through your account will be marked as sent by me on your behalf.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Outbound check stops "can you check this for me" when the agent can reach it | Automatic on replies |
| Session start lists every browser profile and its accounts | Automatic |

## Evidence

Founding case: topic 134088, 2026-11-09. Two asks Echo could have handled itself: a dashboard list its own key reads, and a Slack message it could post as the operator. The Studio's session-start list showed 3 of 12 profiles at the 800-byte cap. New tests are in `tests/unit/reach-aware-false-blocker.test.ts` and `tests/unit/playwright-profile-registry.test.ts`.
