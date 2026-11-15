<!-- bump: patch -->
## What Changed

A conversation that moves to another machine while the agent is in the middle of a step no longer drops that step. On Nov 14 the operator asked for a check-in with another agent; the machine serving the conversation moved it to another machine mid-step, the move closed the busy session after its 30-second allowance, nothing restarted the request, and the one notice about it ("ask me to check it") was filed in the quiet notification feed (Echo Bugs topic 10000002746).

- When a move closes a session before it finished, the old machine now asks the new machine (signed mesh verb `interrupted-move-resume`) to pick the step back up. The new machine acts only once its own records show it owns the conversation at the move's epoch. It then hands the conversation's session a short note (read the recent messages, check what was already done, finish the request, report), injected into a live session or a new session started with the recent history, the same way a forwarded message starts one.
- Exactly one notice reaches the conversation: "I'm picking that step back up there now" from the new machine, or, when the new machine could not take it (older version, unreachable, never became owner, restart failed), the existing "may be incomplete, ask me to check it" notice.
- That notice is now a conversation notice anchored to the person's message, not the quiet-by-default automated category.
- Native app conversations keep their existing in-conversation notice and are not restarted.

## What to Tell Your User

If I move a conversation to another machine while I'm in the middle of something, I now pick that task back up on the new machine and tell you, instead of silently dropping it.

## Summary of New Capabilities

- Cut-off steps resume automatically after a machine move (Telegram conversations). No new routes or settings.

## Evidence

- Unit: `tests/unit/InterruptedMoveResume.test.ts`, `tests/unit/SessionDrainRunner.test.ts` (hand-off after the claim with the claim epoch; lost claim), `tests/unit/userNotices.test.ts`, `tests/unit/MeshRpc.test.ts`.
- Integration: `tests/integration/interrupted-move-resume-roundtrip.test.ts` (real drain runner, real signed mesh, real receiver; refusal and old-peer fallbacks).
- E2E: `tests/e2e/interrupted-move-resume-alive.test.ts` (server boot wiring).
