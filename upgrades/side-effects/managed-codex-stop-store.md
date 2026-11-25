# Side-effects review for the managed Stop store

Tier 1 for this isolated commit. No runtime code opens the store or calls it. Only tests create its SQLite table. The later server and project admission changes require a separate review.

## Decision-point inventory

The store uses unique work and session keys to reject duplicate reservations. Its immediate transaction applies the prepared decision and atomically updates a claim before a directive may be returned. Completed and paused claims cannot issue another directive. Duplicate older callbacks cannot settle a newer outstanding directive.

## Over-block

A lost response leaves the durable claim unresolved. This intentionally preserves exclusion until a lifecycle consumer supplies a terminal outcome. The store has no automatic retirement in this commit.

## Under-block

The store depends on future callers for authentic work, custody, callback and receipt binding. A test can pass those inputs directly. No production entry point invokes it.

## Level of abstraction and signal versus authority

The verified admission and current owner remain external authorities. The store serializes their local effects and applies deterministic identity, transport and state rules. It does not infer project intent from rollout text.

## Tests, operational impact and rollback

Focused unit tests cover existing matching and decision logic, SQLite claim uniqueness, persisted outstanding instructions, pauses and earlier callback replay. No migration, production database, configuration, network access or user-facing behavior changes. Revert the commit to remove the dormant store and its tests.
