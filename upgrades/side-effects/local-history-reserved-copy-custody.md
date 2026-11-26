# Side-Effects Review for Reserved Local History Copy Custody

The dormant copy-child lane now derives and pins the canonical existing destination directories. It creates one dedicated reservation before registering the run. It retains the pin and charge until child close and verified namespace settlement, then releases only the known empty reservation.

## Over-block

Missing or changed directories, expired or foreign intent, insufficient capacity and failed registration refuse the attempt. Missing directories stay missing. An ambiguous creation or settlement failure keeps the charge held for the current process. A restart can reconcile the old tag through existing exclusive takeover rules. The existing live-generation duplicate fence does not promise retry after successful reservation creation.

## Under-block

The caller supplies a trusted internal budget. No production headroom policy or first-use directory bootstrap is introduced. The file-backed reservation is a ledger obligation and cannot control unrelated writers. Run registration assumes the caller supplied its own fixed child. The lane sends no token or permit, so an ambiguous pre-registration failure can leave only an empty namespace. Startup recovery retains charges protected by actual registry or issued-slot records.

## Abstraction fit and interactions

Staging owns the serial slot, destination selection, actual child close and namespace settlement. The ledger owns allocation identity and verifies the zero-written empty placeholder and live volume pin in both release transactions. Internal reservation release does not replace staging's close proof. Pin and charge remain held while cancel or shutdown waits. Only the dedicated allocation releases for a still-prepared operation. Failed settlement adds an in-process tag fence. Prepared artifacts otherwise follow their existing lifecycle.

## Signal versus authority

Under docs/signal-vs-authority.md, identity and settlement are exact protocol facts. Budget and observed free space are resource policy. Neither a reservation nor namespace custody grants consent or write authority.

## External surfaces and machine scope

No HTTP, worker command, schema, configuration, migration or user control is added. All custody and charges stay on the target machine. No retirement behavior changes.

## Rollback

The durable ledger and temporary namespace formats stay unchanged. A future active path must reconcile its children and charges before reverting the fence.

## Class-Closure Declaration

The unbounded-self-action class does not apply. This adds accounting to the existing finite child lifecycle. It starts no child, independent retry or controller.

## Independent Review

The reviewer concurred with the dormant reservation and custody boundary. Future write integration must verify private ownership and mode at each destination and handle pin descriptor close failures independently. The reviewer inspected source and tests without running them.
