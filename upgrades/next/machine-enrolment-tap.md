# Opt a machine into self-maintenance with one tap

<!-- bump: patch -->

## What Changed

The agent can now ask the owner, once per machine, whether it may keep that machine healthy by restarting it about weekly in the small hours and when it gets stuck. The message explains what that means in plain words, lists what is open on the machine, and has two buttons: "Yes, keep it healthy" and "Not this machine". Only the owner's tap counts. On a yes, the agent gives itself permission to restart that machine and nothing else, and records the owner's choice. On "Not this machine" it never asks again for it. Nothing restarts yet: the restart itself and its Skip and Restart now controls come next.

## What to Tell Your User

- **Machine opt-in**: "I can ask you once per machine whether I may keep it healthy with occasional restarts. You answer with one tap in our chat, and 'Not this machine' means I never ask again."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| One-tap machine opt-in | Ask "can you keep the Studio healthy?" and tap the answer in chat |

## Evidence

- Unit: `tests/unit/machine-enrolment-controller.test.ts`; integration: `tests/integration/machine-maintenance-route.test.ts`.
