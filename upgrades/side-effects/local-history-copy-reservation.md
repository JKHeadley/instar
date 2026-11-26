# Side-Effects Review for Local History Copy Reservation Growth

This internal ledger method grows an existing empty allocation for the selected operation. It derives the tag from the real admission, verifies the ledger-created volume pin and placeholder identity, and applies the cumulative ceiling and free-space check in one ledger transaction.

## Over-block

A closed or foreign admission, foreign allocation, changed directory, nonempty placeholder, zero growth, exceeded ceiling, or insufficient free space refuses growth. The numeric ceiling is chosen by the eventual parent coordinator. The ordinary upload ledger remains on its existing path.

## Under-block

The method does not create a reservation, enforce one reservation per run, validate a registered worker, mark approval consumed, or release a charge. The future coordinator owns those phases and must supply the exact dedicated allocation and actual store directory set. A same-ledger pin proves filesystem identity for the directories it contains. It does not prove which run owns those directories. An empty allocation with the same tag can otherwise satisfy this primitive. Filesystem free-space observation does not guarantee that unrelated writers leave that space available. The helper keeps the whole growth charged and may conservatively double count bytes already written to the destination. Bootstrap and transient filesystem headroom require a separate policy.

## Abstraction fit and interactions

The existing ledger owns capacity, transaction serialization, and placeholder file identity. The existing parent-admission brand owns the current operation generation. The originating ledger creates the pinned volume and checks it before and after the capacity observation. Growth changes only the planned bytes on an existing active zero-written row. No writer should seal or write that placeholder. The coordinator must retain the charge through actual child exit and cleanup, especially after uncertain issuance.

## Signal versus authority

Under docs/signal-vs-authority.md, operation tags, admission generations and file identities are exact protocol facts. The caller's byte estimate is policy input. Ledger growth gives no consent or permission to mutate a destination.

## External surfaces and machine scope

There is no route, schema change, release hook, app control, or external I/O. The reservation and filesystem observations are local to the selected machine. No source retirement or new cleanup behavior is included.

## Rollback

Revert the growth method before integration. Any allocation remains owned by the existing ledger and existing disposal semantics. The method introduces no distinct durable format.

## Evidence

Focused tests use a real admission and ledger, grow one allocation twice, and confirm unchanged charges after wrong tag, counterfeit custody or pin, replaced destination, nonempty placeholder, ceiling refusal and capacity refusal.

## Independent Review

The reviewer concurred with the dormant growth primitive and asked for explicit disclosure of allocation and directory selection. The reviewer inspected source and tests without running them.
