# Private App Delete writer ownership

The private signed action requires the same state directory's normally acquired server lock. It revalidates disk ownership after proof preparation and before each request-store or journal mutation. A displaced writer leaves the existing reservation and any committed fact for the successor to reconcile.

The new exclusive-write method rejects bypass acquisition. Existing lock callers retain their behavior. The action remains unmounted. Before wiring the production route, close the remaining simultaneous-start and stale-reclaim overlap in the shared lock and verify the real two-process route boundary.

## 6b. Operator-surface quality

An interrupted server can leave a request recoverable without either process writing the same removal twice.

## Framework generality

The writer check is independent of the device client and harness.
