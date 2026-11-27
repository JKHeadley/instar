# Side-effects review for prepared managed project dispatch

Tier 1 for the unconnected dispatcher and its fixtures. No production entry point invokes its launcher. This commit exercises authorization ordering without granting a real agent launch permission.

## Decision-point inventory

Check the off switch and the authoritative admission. Reserve one local work claim before asking the launcher to start. Recheck admission after launch and verify the native session before binding. Release the launch barrier only after binding. A refused or failed launch records a pending abort or pauses the bound claim and requests cancellation.

## Over-block

An admission change during launch stops the pending worker. The claim remains visible and cannot be automatically reassigned by this component.

## Under-block

The injected authority and launcher must prove one-member custody, valid approved action and exact worker identity. They must provide the startup barrier and cancellation for the allocated launch identity. The dispatcher is not a substitute for those production checks.

## Level of abstraction and signal versus authority

The dispatcher sequences existing authority checks and durable transactions. It neither synthesizes work from conversation text nor treats a successful process start as the admission.

## Tests, impact and rollback

Tests cover duplicate launch, verified binding, stale admission and disabled configuration. No live work, database, policy or external service changes. Revert removes the unused dispatcher and fixture.

A failed claim retirement or pause still invokes cancellation for the allocated worker. The regression test forces the store write to throw after a rejected launch and verifies cancellation without releasing initial input.
