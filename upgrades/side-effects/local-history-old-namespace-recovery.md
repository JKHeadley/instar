# Side-Effects Review for Prior Local History Namespace Recovery

Staging now runs one bounded recovery pass for registered temporary namespaces from older custody generations after reserving its existing metadata budget. It uses the real exclusive admission and validates every registry row and operation binding before removing anything. A settled namespace can make its exact tag eligible for ordinary guarded ledger disposal.

## Over-block

Insufficient metadata space leaves the namespace and its row untouched. A malformed registry, unknown residue or sync failure preserves the charge. A sibling that remains unresolved blocks release for its entire tag. Keeping charges through the full pass may delay further cleanup under pressure.

## Under-block

This only acts on registered exact namespaces. It does not guess ownership for unregistered folders or recover a missing directory after uncertain removal. Filesystem accounting and the separate ledger and jobs transactions do not provide an atomic cross-database guarantee.

## Abstraction fit and interactions

Staging first runs its existing guarded upload recovery so it can reclaim unrelated old charges before metadata admission. It then checks metadata capacity for each eligible run and revalidates the exclusive generation. The registry only returns exact candidate tags after durable disposition. Staging checks the entire tag again through its existing cleanup guard, and only reuses the existing bounded ledger retry sequence if needed.

## Signal versus authority

Under docs/signal-vs-authority.md, serialized custody, exact on-disk identity and directory sync are protocol facts. A batch counter gives no authority to clear a charge. No preview consent or copy permission is issued.

## External surfaces and machine scope

Recovery works only on the selected machine and uses fixed internal diagnostics. No route, schema, external I/O, app control or bookkeeping retirement is introduced.

## Rollback

Reverting the startup call stops future automated passes. Existing typed states and unresolved ledger charges remain owned by their current recovery paths. There is no new durable format.

## Class-Closure Declaration

The unbounded-self-action class does not apply. Startup makes one bounded registry pass. It introduces no repeating namespace scheduler. The established finite ledger retry sequence only handles an exact tag that still could not finish.

## Independent Review

The reviewer concurred with the ordering, exact tag check, and capacity refusal behavior. The reviewer inspected source and tests without running them.
