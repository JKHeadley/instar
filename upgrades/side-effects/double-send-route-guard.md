# Side-Effects Review — Double-send route guard

Slug: `double-send-route-guard`

## Summary

Adds a last-resort Express duplicate-response guard and hardens the shared error handler against
late errors after a response has already been committed. Adds regression coverage for both runtime
paths and a source-level audit test for the classic missing-return route pattern.

## Decision inventory

- New runtime decision: if `res.headersSent` or `res.writableEnded` is already true, suppress a later
  `res.json`, `res.send`, `res.sendStatus`, `res.redirect`, `res.download`, or `res.sendFile` call
  and log it.
- New error-handler decision: if an error reaches `errorHandler` after the response is committed, log
  the late error and do not attempt a second 500 response.
- New test-time decision: a route source audit flags a direct early branch response without a return
  when a later direct handler response exists.

## Over-block

The guard only activates after the response is already committed. It does not block the first
response, does not reject requests, and does not change status codes on normal paths. It may suppress
a second response attempt that a caller previously saw as a thrown server error, but that second
response was never valid HTTP behavior.

## Under-block

The guard does not make route fallthrough logically correct; it prevents the process/request path from
throwing on the second send and preserves stack evidence. The source audit focuses on the high-signal
classic pattern and intentionally does not try to prove every possible nested control-flow path.
Reviewers still need to inspect unusual async flows.

## Level-of-abstraction fit

The runtime protection belongs in Express middleware because duplicate sends are a response-layer
failure that can happen in any route. The source audit belongs in tests because it is a structural
authoring guard, not a production decision point.

## Signal vs authority

The source audit is authority in CI for the narrow syntactic pattern it detects. The runtime guard is
authority only over a response that is already committed; at that point there is no valid second
response to authorize. It logs enough stack context for follow-up instead of silently hiding the
underlying route bug.

## Adjacent interactions

- `requestTimeout` already checks `!res.headersSent`; this change does not alter timeout budgets.
- Dashboard, auth, machine, and API routes are covered because the middleware is installed before
  route registration.
- Express error middleware keeps returning normal 500 JSON for errors before a response is committed.
- Direct low-level `res.end()` is not monkey-patched to avoid interfering with Express internals
  during legitimate first sends.

## Rollback

Rollback is straightforward: remove `duplicateResponseGuard` wiring, remove the middleware export,
restore the old `errorHandler` implementation, and remove the two unit tests. No data migration,
config migration, or user action is involved.

## Evidence

- `npx vitest run tests/unit/duplicate-response-guard.test.ts tests/unit/route-double-send-audit.test.ts`
- `npx tsc --noEmit`
