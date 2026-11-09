<!-- bump: patch -->

## What Changed

The machine that owns a moved app conversation now checks what it is told against the signed message, so team members keep their own limits there. This follows up on #2905 (an independent review found nothing blocking), and none of it can be reached yet: team access requires a one-machine agent.

- A message signed by a team member always stops only their own conversation, even when the forward from an older machine or a held row doesn't say so.
- A team member's message with no person attached, or with a signature this machine can show is wrong, is refused instead of running as the owner's.
- Only the owner's own message can use the owner's name.
- A forwarded app message must say which device sent it.
- Held app messages are delivered by one tested function instead of code inside server start-up.

Rollback: revert. No state to repair.

## What to Tell Your User

Nothing changes for your agent. This tightens a feature that is still being proven on development agents.

## Summary of New Capabilities

None. Safety checks on an existing development-only feature.
