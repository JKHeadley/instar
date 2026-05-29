# TokenLedger 503 Alive Regression Guard — Plain-English Overview

> The one-line version: add a real route-level test that proves the token summary endpoint comes back alive after the two known TokenLedger recovery cases.

## The problem in one breath

The token usage page depends on a small SQLite ledger. Two different bugs recently made that ledger unavailable even though the rest of the agent was running: one was an old database shape that missed a newer column, and one was a native sqlite recovery path that worked for the first subsystem but could leave a later subsystem stuck. Both fixes are now present, but a unit test is not enough for this failure class because the user-facing symptom was not a wrong helper return value. The symptom was an endpoint returning unavailable.

## What already exists

- **The token ledger** — reads token events from SQLite and summarizes usage for the dashboard and API. It also owns the migrations for its tables.
- **The token summary route** — exposes the ledger summary over HTTP and returns unavailable when the ledger cannot be constructed.
- **The schema migration fix** — makes sure the old database shape gains the attribution column before any index or query touches that column.
- **The native sqlite heal fix** — lets a later sqlite subsystem retry after an earlier subsystem already completed the one expensive rebuild successfully.

## What this adds

This adds a higher-value regression test around the actual alive surface. The test creates its own throwaway database in the old shape, opens it with the real ledger, wires the ledger into the real token route, and asks the route for a summary. The expected result is not merely "no exception"; it is an HTTP 200 response containing the seeded token totals.

The same test file also checks the shared native-heal path without rebuilding anything on the developer machine. It simulates one sqlite subsystem seeing the native-version error, records that the heal succeeded, then makes TokenLedger see the same style of error on its first open. The important behavior is that TokenLedger retries cheaply, opens the real database on the second attempt, and the HTTP route still returns data.

## The new pieces

- **A database factory seam on TokenLedger** — a test-only injection point for the SQLite constructor. Normal production construction still calls the better-sqlite3 constructor directly. The seam lets the integration test create the exact native-error timing that happened in the field without corrupting local dependencies or running a package rebuild.
- **An integration regression test** — builds disposable database fixtures and calls the Express token route. It verifies the endpoint behavior that users and dashboard code actually depend on.

## The safeguards

**Prevents a dead endpoint from hiding behind green unit tests.** The test asserts HTTP 200 and seeded data, so a future migration ordering bug or retry regression is visible as the same kind of failure users saw: the route stops being alive.

**Prevents local machine state from affecting the result.** The database file is created fresh inside a temporary directory for each test. The native heal scenario is simulated through controlled injection and spies, so it does not depend on whether the developer's installed sqlite binding is healthy.

**Prevents accidental second rebuilds.** The shared-heal test checks that the earlier subsystem consumed the one rebuild and TokenLedger recovered by retrying, not by starting another expensive repair.

## What ships when

This ships as one small test-hardening change. The production code receives only the constructor seam needed to make the native-error timing testable. The behavior under normal construction remains the existing direct SQLite open through the native-module healer.

## What you actually need to decide

Approve adding this route-level regression guard so the two known TokenLedger 503 causes cannot return silently.
