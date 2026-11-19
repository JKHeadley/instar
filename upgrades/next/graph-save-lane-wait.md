# Saves no longer queue behind slow background checks

<!-- bump: patch -->

## What Changed

On an agent running on more than one machine, every save to the shared conversation history went through the same one-at-a-time step as the background check of the other machines. When a machine was slow, that check took up to a minute and saves waited behind it until the Conversations page gave up ("your agent is not answering right now"). A save now waits at most 3 seconds for that step and then goes through on the history that is already open, as reads already did. Separately, the background history check (one to two minutes of reading on a large history) starts at most once every 5 minutes instead of after every save.

## What to Tell Your User

- **Accept all on a busy machine**: "Accepting suggested projects keeps going when your machines are busy; saves no longer wait behind the agent's background checks."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Saves answer within a few seconds while background checks run | Automatic |

## Evidence

Accept all round 4 part 4 (topic 144007): live run 2026-11-19 03:32-03:44Z on 1.3.1906-local.2ca3c24 stopped at 2 of 14; Studio log: readiness check 25-51 s inside the owner step, history check 70-118 s re-run after each save. Tests: `tests/integration/graph-default-boot.test.ts` (save commits while the owner step is held; one history check per 5 minutes).
