# Side-Effects Review for First Copy Permit Startup Quarantine

Staging startup now checks for a durable first permit before reclaiming old upload tags. It validates its operation, sealed preview index, registered run and exact active reservation. An old applying operation with a matching slot becomes interrupted. Its slot and charge remain quarantined even if its temporary namespace settles.

## Over-block

An applying operation without a valid slot, malformed or orphaned data, or an inconsistent reservation stops startup cleanup before releasing old tags. A valid issued slot retains all allocations for its tag. That can reduce available space until reconciliation is supported.

## Under-block

The recorder establishes issuance, with no proof of delivery, completion or whether data was copied. Staging exposes its existing interrupted state internally. A future user-facing copy status needs to represent the possible partial result explicitly. This checkpoint has no permit reconciliation or retirement step.

## Abstraction fit and interactions

The existing exclusive admission protects after old child exit. The bounded SQLite inventory and ledger map validate all bindings before ordinary disposal. The in-process tag fence is reconstructed from the durable slot on every restart. Exact namespace cleanup can still remove owned temporary files under the existing recovery design, while the ledger charge stays behind. Ordinary uploads without permits keep their existing behavior. No first permit is resent.

## Signal versus authority

Under docs/signal-vs-authority.md, exact operation, preview record, generation, run and reservation bindings are protocol facts. Their presence fences recovery. No state gives authority to reissue a permit or copy a conversation.

## External surfaces and machine scope

No route, new app control, schema creation, external I/O or deployment is introduced. The inventory is optional for existing disks and remains machine-local.

## Rollback

After real issued slots exist, keep this fence or reconcile every slot and reservation first. Reverting after activation without that reconciliation could release a charge prematurely.

## Class-Closure Declaration

The unbounded-self-action class does not apply. Startup performs one bounded inspection with no worker delivery or scheduled permit retry.

## Independent Review

The reviewer concurred that startup installs all fences before disposal and that subsequent cleanup paths respect them. The future live coordinator must install its in-process fence when it records issuance. The reviewer inspected source and tests without running them.
