## What Changed

- A message the agent sends while its server is restarting is now delivered after the restart. The restart placeholder answers "still starting up" and never sends anything, but the recovery check treated that answer as "may already be delivered", so those messages were never sent.

## What to Tell Your User

Messages I send you while I'm restarting (for example during an update) now arrive once I'm back, instead of quietly going missing.

## Evidence

- Reproduced on a live agent: three messages sent during a server restart were stored with the placeholder's exact answer and were then marked "may already be delivered" and never sent.
- Unit tests cover the placeholder answer (replayed), a different 503 answer, a lookalike body with an extra field, and the placeholder body with a different status code (all three kept uncertain).

## Summary of New Capabilities

None. This fixes message recovery after a restart.
