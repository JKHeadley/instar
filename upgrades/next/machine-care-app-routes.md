# Machine care from the owner's phone

<!-- bump: patch -->

## What Changed

The Instar app can now read each machine's restart status and, for the machine it is connected to, skip a restart, undo a skip, change the restart hours or ask for the Restart now card. Only the owner's own paired phone can do this, and the agent cannot use this path itself. Restart still waits for the owner's tap on the card. The app's own screen for this comes in an app release; until then the dashboard's Machine care page works on a phone.

## What to Tell Your User

- **Machine care in the app**: "Your phone can now skip or move a machine's restart through the app. The app's own screen for it comes in an app update; until then, use the Machine care page on the dashboard."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Skip, undo, change hours or ask for a restart from the phone | The Instar app (screen coming in an app release) |

## Evidence

- E2E: `tests/e2e/machine-care-app-alive.test.ts`.
