# Side-Effects Review — Apprenticeship Cycle Store

**Version / slug:** `apprenticeship-cycle-store`
**Date:** `2026-06-03`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds `ApprenticeshipCycleStore`, a small better-sqlite3 store for one row per
apprenticeship differential cycle, plus authenticated HTTP routes for recording,
listing, fetching, and closing cycles. The server creates
`server-data/apprenticeship-cycles.db` when a state directory is available and
registers the SQLite handle with `SqliteRegistry`.

## Decision-point inventory

- `ApprenticeshipCycleStore.record` — add — validates required fields, stores
  array fields as JSON, and defaults status to `open`.
- `ApprenticeshipCycleStore.list` — add — lists recent cycles globally or by
  `instanceId`, with a bounded positive limit.
- `ApprenticeshipCycleStore.get` — add — returns one parsed cycle or null.
- `ApprenticeshipCycleStore.closeCycle` — add — marks a cycle closed and returns
  the updated parsed row.
- `/apprenticeship/cycles*` routes — add — bearer-protected CRUD-style API with
  503 when the store is unavailable, 400 for invalid input, and 404 for unknown
  ids.

## 1. Over-block

The store rejects missing `instanceId`, non-positive `cycleNumber`, empty `task`,
empty `menteeOutput`, and non-string entries in array fields. That is intentional:
these are structural capture records, and accepting malformed rows would make the
later retro-harvest less reliable.

The route layer returns 503 when the store is not wired. This is stricter than
returning an empty list, but it is the right failure mode because callers need to
know the feature is unavailable rather than "no cycles exist."

## 2. Under-block

The store does not enforce that `instanceId` references an existing
apprenticeship instance. That keeps this Tier-1 change additive and avoids
coupling the cycle recorder to instance lifecycle transitions. A later workflow
layer can add instance-aware capture if it needs that guarantee.

The `coaching` and `kind` fields are plain strings, not constrained enums. The
current default `kind` is `differential-cycle`; preserving strings keeps room for
future cycle subtypes without a migration.

## 3. Level-of-abstraction fit

Persistence belongs in `src/monitoring` with the other small operational stores,
not in the apprenticeship lifecycle JSON registry. The lifecycle registry owns
instance state and gates; the cycle store owns repeatable evidence captured
during an active mentorship.

The HTTP routes stay thin: they validate availability, call the store, and map
store validation errors to 400 responses.

## 4. Signal vs authority compliance

No conversational/product judgment is delegated to brittle logic. The change only
persists explicit caller-provided fields and exposes them through authenticated
routes. It does not decide whether a cycle was good, whether a mentor was right,
or whether an instance may complete.

## 5. Interactions

- **SqliteRegistry:** the store registers and unregisters its handle so native
  SQLite lifecycle checks include the new database.
- **AgentServer shutdown:** the store closes during server stop, best-effort,
  beside the other monitoring stores.
- **ApprenticeshipProgram:** instance routes remain unchanged. Cycle capture is
  adjacent to, not inside, the lifecycle transition gate.
- **Monitoring/e2e:** the e2e alive path asserts `POST /apprenticeship/cycles`
  returns 201 when the server has the store and not 503.

## 6. External surfaces

Adds four bearer-authenticated API routes:

- `POST /apprenticeship/cycles`
- `GET /apprenticeship/cycles?instanceId=&limit=`
- `GET /apprenticeship/cycles/:id`
- `POST /apprenticeship/cycles/:id/close`

Adds one database file under server state when the server is running:
`server-data/apprenticeship-cycles.db`.

## 7. Rollback cost

Rollback is a code and route revert. Existing `apprenticeship-cycles.db` files
can remain inert on disk; the server simply stops opening them after rollback.
No migration is required because no existing schema is modified.

## Conclusion

Ship. This is an additive Tier-1 persistence/API surface with focused store,
integration, and e2e coverage. The only failure-mode hardening is returning 503
when the store is unavailable, which is the correct liveness signal.

## Evidence pointers

- `tests/unit/apprenticeship-cycle-store.test.ts`
- `tests/unit/SqliteRegistry-wiring.test.ts`
- `tests/integration/apprenticeship-routes.test.ts`
- `tests/e2e/apprenticeship-lifecycle.test.ts`

