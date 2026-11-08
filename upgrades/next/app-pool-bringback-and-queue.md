<!-- bump: patch -->

## What Changed

Three fixes from the first real two-machine move of an app conversation. All are behind the app-conversations pool feature, which is on for development agents only.

- When the machine running a moved conversation stops answering, the phone offers "Bring it back here" after about 2 minutes, instead of 15. The serving machine now counts the other machine as answering only if it reached it directly in the last 2 minutes, the rule pool readiness already uses.
- A message saved while that machine was unreachable is now delivered once it answers, on an agent without Telegram too. Before, the queue passed app messages through a delivery step that only Telegram sets up, so they expired unsent.
- A message saved for a moved conversation now survives a restart of the machine that serves your app. Before, a restart dropped any such message that had waited more than 2 minutes.

Rollback: revert. No state to repair.

## What to Tell Your User

Nothing changes for your agent. This fixes a feature that is still being proven on development agents.

## Summary of New Capabilities

None. Three bug fixes on an existing development-only feature.
