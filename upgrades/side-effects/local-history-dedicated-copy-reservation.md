# Side-Effects Review for Dedicated Local History Copy Reservations

The ledger can create one dedicated copy reservation for a live parent admission and operation. Its handle captures the newly created allocation ID, volume pin and cumulative ceiling. Growth cannot be redirected to another empty row under the same tag.

## Over-block

A duplicate under the same live admission, invalid pin, invalid amount, exceeded cumulative ceiling or insufficient capacity refuses creation or growth. A known capacity refusal before any row exists permits retry. An ambiguous creation failure fences another attempt under that admission and leaves any charge available to existing tag recovery.

## Under-block

The live duplicate fence is process-local and does not add a durable copy-run association. Future orchestration owns the durable binding, checks the exact registered worker, supplies trusted same-volume destination paths and handles cleanup. The empty file tracks a logical reservation. Actual filesystem headroom and bootstrap directory creation remain separate design work.

## Abstraction fit and interactions

The existing ledger creates and charges the empty placeholder using its established two-step transaction. Admission and volume identity are checked around the capacity observation and placeholder recording. The new handle exposes a fixed allocation ID and bounded growth. It adds no release or write method. The coordinator must settle custody before exactly scoped release. A failed placeholder create can leave a charged row without returning its ID.

## Signal versus authority

Under docs/signal-vs-authority.md, the live admission brand, pinned filesystem and immutable allocation ID are exact constraints. Numerical ceilings remain policy inputs. A reservation grants no consent or destination write authority.

## External surfaces and machine scope

This is an internal ledger API with no new schema, HTTP, migration, app control or notification. The admission and pin are local to the selected machine. Existing upload allocation uses the same underlying path with its established behavior.

## Rollback

Reverting the internal handle leaves any ledger rows under their existing operation-tag cleanup. No new persistent row format or payload was added.

## Evidence

Focused tests check a real branded admission, an unrelated empty same-tag allocation, duplicate calls across ledger handles, pinned-path and byte refusals, and injected placeholder creation failure with a retained durable charge.

## Independent Review

The reviewer concurred with the dormant design and called out the need to bind a real jobs operation before exposing the API. The process-local fence also has the ledger's fixed record bound. The reviewer inspected source and tests without running them.
