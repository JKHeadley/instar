# Restart check waits until the server has finished starting

<!-- bump: patch -->

## What Changed

After a machine restarts, the check that proves everything came back now counts the agent's server as back only once it says it has finished starting. Before, an answer from a server that was still starting up could count. A server that is still starting is checked again on the next try, and fails the check only if it has not finished within the usual ten minutes.

## What to Tell Your User

- **Restart check**: "After a restart I now wait until my server has fully started before I say it came back."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Restart proof counts the server only when fully started | Automatic; shown in the machine care status |

## Evidence

- Unit: `tests/unit/machine-restart-proof.test.ts`. E2E: `tests/e2e/machine-maintenance-lifecycle.test.ts`.
