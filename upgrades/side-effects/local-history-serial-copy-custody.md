# Side-Effects Review for Serial Local History Copy Custody

Staging can take custody of an already spawned internal copy child after checking the current sealed intent. It shares the serial child slot with verification, preparation and preview. The slot protects the operation tag through real close and exact namespace cleanup.

## Over-block

Competing work returns busy while custody is held. Registration or cleanup failure can leave a charged empty namespace. If a child cannot be stopped, shutdown waits for its actual close and retains custody. The intended coordinator must pass only its own fixed child.

## Under-block

This slice creates private empty namespace metadata and tracks actual child close. It does not return an allocator token, approve a copy, send a permit, prove child readiness for writes, bind a physical reservation or establish bootstrap headroom. Future live integration needs those boundaries before routing work to this lane.

## Abstraction fit and interactions

Staging owns caller transfer, the operation-wide serial slot and tag disposal. The registry owns exact namespace registration and settlement. Cancellation, expiry and shutdown signal the same owned child with one bounded escalation and wait for close. A registration failure after binding may still use exact cleanup after close. A failed settlement remains fenced by durable registry state. A failure that precedes custody transfer leaves the child with its original caller.

## Signal versus authority

Under docs/signal-vs-authority.md, intent bindings, child-object custody and exact namespace identities are protocol facts. The lane handles one internal child and supplies no permission to write conversation data.

## External surfaces and machine scope

No HTTP, schema, worker command, UI or app activation is introduced. Custody and temporary folders stay on the target machine. No bookkeeping retirement is included.

## Rollback

Before activation the new entry point can be reverted. Future live changes must settle or preserve registered namespace records and charge before dropping this fence.

## Class-Closure Declaration

The unbounded-self-action class does not apply. The explicit operation holds one child, sends at most one termination and one escalation, and launches no worker or replacement.

## Independent Review

The reviewer identified a reentrant stop signal error. The stop flag now sets before signaling. The regression waits for real close despite the injected error and verifies exactly one termination signal and one escalation. The reviewer concurred with the corrected lifecycle boundary without running tests.
