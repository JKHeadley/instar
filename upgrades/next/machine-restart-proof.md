# After a machine restarts, the agent checks that everything came back

<!-- bump: patch -->

## What Changed

Every time a machine restarts, for any reason, the agent now writes it down once and then checks, over ten minutes, that its parts came back: its server, its emergency backup line, messaging between agents, the public tunnel, the remote desktop, its subscription logins, and the other agents on that machine. It compares with how things were shortly before the restart, so something that was already broken is not blamed on the restart. A restart nobody planned is recorded as unplanned. The result shows in the machine care status. Nothing in this change restarts a machine.

## What to Tell Your User

- **Restart check-up**: "After any of your machines restarts, I now check that everything came back the way it was and keep a record, so I can tell you plainly what returned and what didn't."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Post-restart proof | Automatic after every boot; ask "did everything come back after the restart?" |

## Evidence

- Unit: `tests/unit/machine-restart-proof.test.ts`.
