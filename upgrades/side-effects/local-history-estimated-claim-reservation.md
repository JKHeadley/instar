# Side-Effects Review for Estimated First Claim Reservations

The dormant copy-child lane now requires a fresh estimate bound to the exact sealed preview and request. It checks the policy's block size against the actual pinned volume and charges the sum of the internal bootstrap amount and first claim estimate before run registration.

## Over-block

Missing or changed store state, changed receipt, insufficient ceiling and mismatched filesystem block policy refuse admission. A failure before child custody transfer leaves the child with its original caller. A failure after transfer follows the existing bounded stop and close sequence.

## Under-block

Point-in-time sizing does not establish a live write plan or guarantee a physical peak. There is no production default or absent-store bootstrap policy. The child receives no token or permit and the actual write path still needs fresh file and writer checks.

## Abstraction fit and interactions

Staging snapshots the caller policy, verifies all selected artifacts through the fixed reader, and rechecks the exact receipt digest before transferring custody. The serial lane then pins the store, checks block size and creates the original dedicated reservation with the combined charge. Charge retention and exact release after actual close and verified namespace settlement remain in staging and the ledger.

## Signal versus authority

Under docs/signal-vs-authority.md, exact receipt, request and volume block size are protocol facts. The estimate is resource policy and never grants copy consent or a mutation permit.

## External surfaces and machine scope

There is no route, schema, worker command, setting, migration or app control. The policy and reservation are machine-local. No records are retired.

## Rollback

No persistent format changes. Reverting before copy activation leaves existing staging and reservation semantics available. Unresolved charges remain in their existing custody.

## Class-Closure Declaration

The unbounded-self-action class does not apply. The explicit call uses one existing planning reader and then takes custody of one caller-owned child. It does not retry or create a controller.

## Independent Review

The reviewer concurred with the dormant binding. The estimate may create or tighten local writer-lock metadata before the volume check and reservation. The already-spawned child remains inert and caller-owned during the estimate and until transfer. The reviewer inspected source and tests without running them.
