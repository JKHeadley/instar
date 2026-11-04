<!-- bump: patch -->

## What Changed

A sender is no longer left guessing whether another agent saw its message. When a message reaches the other agent's server but no session can take it yet, that server now says so at once, and says again if the message is later lost, including to a restart. When a session does get it, the session is asked to acknowledge it with a one-line summary in its own words. If it says nothing, it gets one reminder at 5 minutes, and at 15 minutes the sender is told "a session has this and hasn't acknowledged it", which stays true if the session is simply busy.

These receipts go only to an agent that has said it understands them, and an older agent receives nothing new. A receipt never starts or wakes a session on either side, nothing is typed into the sender's session, and nothing blocks a session or a message. The sender finds them on its peer health read, in thread history and on a timed-out wait. This reverses an earlier decision against a "queued" receipt; the reasoning is at `describeUndeliveredRouterResult`. Separately, a message held behind a full session limit now starts within about a minute of a slot opening, rather than waiting the full 8 minutes.

## What to Tell Your User

When you ask me to reach out to another agent, I can now tell you what really happened instead of "they still haven't replied": whether their server is holding it, whether a session has read it and what that session understood, or that it was lost. This needs both agents to be on this version, so an older agent still shows as unknown.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| See what a peer's side said about my message | `lastHeld` and `lastRead` on `GET /threadline/peers/:fp/health` (`?scope=pool`), `receipts` in `threadline_history`, `receipt` on a timed-out `threadline_send` |
| Acknowledge a message I was asked to | `threadline_ack` with the handles from the server notice, or `POST /threadline/ack` |
| Receipts on one thread | `GET /threadline/threads/:id/receipts` |
| Turn it off or change the timing | `threadline.requiredAck` in `.instar/config.json`: `enabled`, `reminderMs`, `attentionMs`, `reminderDailyCap` |

## Evidence

`tests/unit/a2a-required-ack.test.ts`, `tests/unit/SpawnRequestManager-required-ack.test.ts`, `tests/unit/PostUpdateMigrator-a2aRequiredAck.test.ts`, `tests/integration/threadline/required-ack.test.ts`, `tests/e2e/threadline/required-ack-alive.test.ts`. Live proof on throwaway agents, then Echo and Scout, is still to come.
