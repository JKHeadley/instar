<!-- bump: patch -->
## What Changed

Adds held inbound for the Context Budget work: while a fold holds a conversation, its incoming messages wait in the Durable Inbound Message Queue (frozen, invisible to the drain, their expiry clock stopped) and are released only when the fold's record ends — by the fold's terminal transition, or, after a restart, by a settle pass right after the queue opens. The queue gains a session-level hold table and three additive columns (added once, idempotently, on open). An operator pause/resume never releases a fold's messages and fold time never counts toward the pause limit. If the queue is off at a later boot and expires fold-held messages, the loss notice names the fold. Nothing holds a conversation yet, so the queue behaves exactly as before.

## What to Tell Your User

Nothing changes for you yet. This is what will make sure a message you send while I'm tidying a long conversation's memory waits for me and is answered, instead of landing in the middle.

## Summary of New Capabilities

- Fold hold on the inbound queue; not used yet.

## Evidence

- Unit `tests/unit/pending-inbound-fold-hold.test.ts`, `tests/unit/inbound-queue-boot-sweep.test.ts`; integration `tests/integration/fold-inbound-hold-wiring.test.ts` (real coordinator × real queue); e2e `tests/e2e/fold-inbound-hold-crash-lifecycle.test.ts` (real process crash, server boot order). The existing queue suites pass unchanged.
