## What Changed

- **A conversation move no longer leaves two live sessions.** When a topic is moved to another machine and its current owner is told to hand it over, the owner closes its own session and then hands ownership to the new machine. If that close was refused, the owner handed ownership over anyway, so the old session kept running on a conversation it no longer owned while the new machine started a second one (2026-10-23: two sessions ran the same destructive job on the same Telegram topics for about ten minutes). Now a refused or failed close aborts the hand-over (new drain outcome `refused-close-failed`): ownership stays with the session that is still running. A skip that means there is nothing left to close (no local session, already ended) still completes the hand-over.
- **`POST /pool/transfer` answers 409 `failedNeedsRetry` for that outcome and sets no pin**, the same way it already treated an emergency-stop abort. Before, it set the pin, so the next message would have re-placed the topic on the new machine while the old session lived.
- **The close on a deliberate move is no longer refused by two guards that never applied to it.** The old owner is usually not the serving-lease holder, so the lease gate refused every close from a remote hand-over; and the user has usually just written, so the recent-user-message keep refused it too. The runtime-private `topicTransferClose` assertion now lifts those two (it already lifted `standing-session`). Every other keep-guard (protected, active subagent, pending injection, recovery in flight, …) still applies, and a refusal now aborts the move instead of splitting it.

## What to Tell Your User

Moving a conversation to another of my machines can no longer leave me running it in two places at once. If the old machine cannot close its copy, the move is cancelled and I tell you it needs a retry, instead of two copies of me working on the same thing.

## Summary of New Capabilities

- Drain outcome `refused-close-failed` (owner-side): the hand-over is aborted when the local session could not be closed.
- `POST /pool/transfer` returns 409 `{ failedNeedsRetry: true, drain: { status: 'refused-close-failed', … } }` with no pin set.

## Evidence

- Before: `SessionDrainRunner` landed the target ownership claim regardless of `terminateSession`'s result; the old unit test asserted only that a vetoed close was "carried in the outcome detail". On a non-lease-holder owner the drain close was refused `not-lease-holder` by `#terminateSessionInternal`, so every remote hand-over moved ownership with the session still alive — the incident shape.
- After: `tests/unit/SessionDrainRunner.test.ts` shows a refused close (protected, not-lease-holder, recent-user-message, active-subagent, in-flight) and a thrown close each abort with no claim CAS, while no-local-session / not-found / already-* still land the claim. `tests/unit/session-manager-terminate.test.ts` shows the drain close terminating on a non-lease-holder with a recent user message, the public path still lease-refused, and an active subagent still vetoing. `tests/integration/pool-placement-transfer-routes.test.ts` shows the route answering 409 with no pin and ownership/epoch untouched.
