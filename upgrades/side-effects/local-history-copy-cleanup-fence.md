# Side-Effects Review for Local History Copy Cleanup

Staging now uses the branded parent admission and initializes the temporary-run registry under its existing metadata reservation. Before reclaiming old uploads it validates any existing typed registry. Cleanup preserves allocations for an operation whose registered namespace is unsettled.

## Over-block

Unsettled rows, invalid registry structure, or a disposed row with a present or unverifiable namespace retain the charge. A missing registry on an older checkout allows ordinary upload-ledger recovery. Unknown residue is preserved. This checkpoint does not run namespace recovery itself.

## Under-block

The fence covers registered namespaces. A future copy coordinator must register before payload creation, hold the worker lane through actual close, and bind outstanding permits and reservations to its durable run. A point-in-time absence check does not establish a power-loss durability boundary for namespace removal.

## Abstraction fit and interactions

The temporary registry owns exact generations and namespace identities. Staging owns tag cleanup and refuses a charge release when the registry cannot establish settlement. The old upload recovery order remains before new metadata admission, so unrelated old charges can still be reclaimed under pressure. Staging initializes the table after acquiring the existing metadata reservation. The same check runs during cancellation, bounded cleanup retries and shutdown.

## Signal versus authority

Under docs/signal-vs-authority.md, live custody and typed namespace records are protocol facts. A disposed state alone does not bypass the physical absence check. No copy consent, permit or generic cleanup grant is introduced.

## External surfaces and machine scope

The internal strict table is additive. No HTTP, UI, notification, replica or configuration changes are introduced. Authority and records stay on the target machine. Row retirement remains outside this checkpoint.

## Rollback

Reverting the initialization can leave the private table in place. Reverting the fence after registered copy runs exist would require first settling existing namespaces and charges. There is no activated copy worker in this checkpoint.

## Class-Closure Declaration

The unbounded-self-action class does not apply to this change. It adds a refusal to the existing bounded cleanup attempts and starts no additional attempt or controller.

## Independent Review

The reviewer identified that a strict table without its primary key could hide an unsettled record behind duplicate run IDs. The validator now requires the exact primary key, nullability and defaults. A regression checks refusal and retention of the old charge with that malformed registry. The reviewer concurred after rereview and did not run tests.
