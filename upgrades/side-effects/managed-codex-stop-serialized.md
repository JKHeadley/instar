# Side-effects review for atomic verifier and issuance

Tier 1 for the disposable runtime path. It passes the current enrollment directly from the SQLite transaction to the bounded receipt verifier before committing issuance. No normal project startup caller is added.

## Decision-point inventory

The immediate transaction orders local pause, verification and issuance. A known pending or retired worker stays under managed refusal. An unknown worker still returns control to the existing route policy.

## Over-block

The database can return busy to a competing writer while verification completes. Production composition must reconcile this safely and must not acknowledge a pause until its own write commits. Verify holds the lock only for bounded local work.

## Under-block

The lock does not establish external project or machine custody. A live provider must independently prove those at the effect boundary. The off switch and absence of live enrollment prevent runtime dispatch here.

## Level of abstraction and signal versus authority

Verification supplies evidence. The durable work transaction owns local ordering and output issuance. Pause and completion use that same transaction.

## Tests, impact and rollback

Two database connections exercise the write lock, pause after issuance and receipt handling. The native lifecycle retains its existing enabled and disabled cases. Revert restores the earlier disposable runtime seam. No live data or migration changes.
