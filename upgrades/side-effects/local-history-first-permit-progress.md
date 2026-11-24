# Side-Effects Review for First Copy Permit Progress

The isolated SQLite recorder can persist a sticky stop flag and the acknowledgement digest for the exact first permit. It accepts a matching acknowledgement after a stop request and retains the original slot.

## Over-block

Wrong operation, run, generation or permit identity refuses the observation. A conflicting second digest fails closed. Invalid schema, malformed status or a preexisting progress record without that operation’s original slot also refuses. Exact repeat observation is idempotent.

## Under-block

An acknowledgement digest records one assertion from an eventual trusted coordinator. This helper does not verify the child, canonicalize IPC messages, release storage, clear the pending slot or issue another permit. The live coordinator must enforce the stop flag before any further issuance. It must also prove who sent each acknowledgement.

## Abstraction fit and interactions

The existing first permit remains the identity source. A separate strict table holds at most one row per recorded operation and leaves old first-permit rows readable. Writes require the caller's existing FULL-sync jobs transaction and roll back with it. No existing route reads or initializes this table.

## Signal versus authority

Under docs/signal-vs-authority.md, the fixed identity and sticky stop state are protocol facts. Each digest preserves bounded evidence. Neither the digest nor its observation permits a write.

## External surfaces and machine scope

The recorder is machine-local and has no route, active worker caller, raw diagnostic or conversation content. It introduces no runtime table migration or retirement.

## Rollback

Before integration the recorder can be reverted without changing active state. After use, preserve the original slots and their matching stop and acknowledgement records during rollback.

## Evidence

Real SQLite fixtures test stop plus late acknowledgement, persistence after reopen, exact replay, conflicting digest, wrong run identity and outer rollback.

## Independent Review

The reviewer flagged repeated reads of the observation kind and possible inheritance of orphan progress. The recorder now snapshots the kind and refuses a new slot for an operation carrying orphan progress. The reviewer inspected source and tests without running them.

The reviewer concurred after checking both corrections.
