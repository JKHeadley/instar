# Messages an overloaded machine refused move to a machine with room right away

<!-- bump: patch -->

## What Changed

When a machine's overload brake (work admission) is enforced and refuses to start a session for an incoming message, the message is saved and the person is told so. The saved message is now placed on a machine with room on its first retry, instead of retrying the overloaded machine up to ten times (about 25 minutes) before moving. If placement picks the same machine because it has recovered, the message is delivered there; if no machine can take it yet, it keeps waiting and retrying as before, so nothing is lost. Messages saved for other reasons are unchanged. A new counter, `admissionRefusalReplaced`, shows how often this happened.

## What to Tell Your User

- **Faster answers when a machine is overloaded**: "If one of my machines is too busy to start a new session for your message, I now hand it to another machine with room straight away instead of making you wait."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Admission-refused messages re-placed on the first retry | Automatic |

## Evidence

Tests: `tests/unit/queue-drain-loop.test.ts` adds peer placement, recovered-local delivery, no-machine-yet retry without loss, sender refusal terminal, and other reasons unchanged; 48 passed.
