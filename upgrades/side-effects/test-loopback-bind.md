# Side-Effects Review — test servers bind loopback, not the wildcard

**Version / slug:** `test-loopback-bind`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tests only. `tests/vitest-setup.ts` now makes an ephemeral bind with no host land on 127.0.0.1. A bare `listen(0)` binds the wildcard, and on macOS Node's SO_REUSEADDR lets that socket share a port number with another process's 127.0.0.1 socket, which then receives the test's connections. That is the "expected 401 to be 201" and "expected 404 to be 201" class that fails random route tests only when suites run side by side, and that the isolation re-run cannot clear for a PR touching a file the test imports (routes.ts). The verify logs hold about ten such rows since 10-25, including tests/integration/mandate-routes.test.ts on 11-01. Measured: 2313 of 25000 wildcard servers answered by a second process holding 4000 loopback ports; 0 of 6000 with this patch.

## Decision-point inventory

No decision point. Test harness only; nothing under src/ changes and nothing ships.

---

## 1. Over-block

A test that needs a real wildcard bind must now say so. One did (tests/unit/secret-externalization-hook-injection.test.ts) and now binds `::` by name. An IPv6-only client of a bare `listen(0)` server would be refused; a repo search found none.

## 2. Under-block

Servers in child processes that tests spawn are not patched, nor are cluster workers. A spawned script that calls `listen(0)` with no host keeps the old exposure.

## 3. Level-of-abstraction fit

One setup file covers 285 test files instead of editing each, and covers future tests. The patch is on the private `_listen2` step because passing a host to `listen` defers the bind and breaks callers that read `address()` straight after.

## 4. Signal vs authority compliance

Not applicable: no judgment, gate or message.

## 5. Interactions

The test-runner limiter and the Supertest retry are untouched. The retry still covers loopback connect pressure.

## 6. External surfaces

None. Nothing outside the test processes changes.

## 7. Rollback cost

Revert the commit; no state, config or migration.

## Second-pass review

**Reviewer:** independent general-purpose reviewer subagent

Concurred. It confirmed that Node 24's `listen()` with no host reaches `_listen2(null, 0, ...)` for every form, that fd, handle, pipe and explicit-host paths are untouched, that `localhost` still reaches a 127.0.0.1-only server on Node 24, and that nothing reads `address().address` except the new guard. A rename of `_listen2` in a Node upgrade fails the guard test. It found one stale comment, now fixed by binding `::` by name in the hook-injection test.
