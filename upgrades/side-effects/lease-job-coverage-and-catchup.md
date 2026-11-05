# Side-Effects Review — lease job coverage and catch-up

**Date:** 2026-11-05  
**Author:** echo

## Summary

The feature records signed, bounded job metadata from registered peers, reports gaps on the awake holder, reconciles only shipped defaults, and makes promotion catch-up explicit. No job body, command, token, or raw dependency path is replicated. Git-sync remains disabled.

## 1. Over-block

Coverage uncertainty never blocks scheduler startup or routine cron work. Promotion catch-up defaults to asking and may delay an overdue job until a person reviews it. That is deliberate for time-specific work that may have been completed elsewhere. Normal same-machine restart catch-up remains available.

## 2. Under-block

Snapshots are nonce-bound and signed against the registered machine key, with schema and size limits. They cannot authorize a job launch. A `run-once` policy on a cross-machine transfer resolves to ask without an independently verified witness of earlier execution. Live lease and read-only state are checked again before a permitted spawn.

## 3. Level-of-abstraction fit

The peer snapshot carries only catalog metadata. Source job definitions and their dependencies stay local. The holder's coverage monitor interprets the observations; the scheduler owns launch admission. The attention adapter confirms delivery for this feature before an alert is marked sent.

## 4. Signal vs authority compliance

Per docs/signal-vs-authority.md, peer evidence is signal, not authority. Stale, conflicting, incomplete, or unverified evidence produces an unknown status and alert. Only local validated definitions and the live lease can admit execution. Add-only default repair uses shipped definitions and preserves user changes.

## 5. Interactions

Coverage polling starts even on a scheduler-less standby and stops with the server. Promotion catch-up shares an admission fence with cron. A durable promotion journal keeps ask, skip, requested, triggered, and uncertain outcomes across restart. Existing attention routing is used for alerts; a failed transport remains retryable.

## 6. External surfaces

`GET /jobs/coverage-snapshot` provides signed, bounded metadata to authenticated peers. `GET /jobs?scope=pool` adds a coverage summary with source, age, status, and reason. Operator alerts list job slugs and status without execution details or dependency paths.

## 7. Multi-machine posture

Each machine polls registered non-revoked peers and retains its own last verified observations. The promoted holder can compare against a previously observed offline peer, with age and availability shown. There is no claim of cross-machine exactly-once execution; an uncertain transfer asks a person.

## 8. Rollback cost

Source rollback leaves metadata snapshots and catch-up journals inert. The separate lease-follow and safe catalog reconciliation fixes remain. Before rolling back catch-up, operators should inspect overdue jobs because the old startup path could launch them automatically.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`, `enforcementType: ratchet`, `citation: tests/unit/self-action-convergence.test.ts`. The coverage alert retry has a durable one-hour failed-send floor. The registered controller model runs under permanent send failure and asserts the rate floor across reconstruction. The catch-up notice uses the same durable retry floor.

## Verification follow-up (2026-11-05)

The full-suite silent-fallback ratchet found five new fallback shapes in the coverage implementation. They are now explicitly marked with their safe behavior: unreadable peer snapshots become unknown coverage, tick and audit errors are logged and retried on the bounded cadence, absence of a prior episode is normal, and an unreadable catch-up journal refuses catch-up. This adds no new write or execution authority. Targeted ratchet and coverage tests pass. The first commit attempt was rejected by the fresh-trace gate; this artifact and the new trace record the follow-up review.

## HTTP and lifecycle proof completion (2026-11-05)

Added real route integration coverage for authentication, invalid nonces, nonce-bound signatures, and a scheduler-less standby. Added an AgentServer lifecycle test proving production route construction installs a real signing monitor rather than leaving the endpoint at 503. The fixture uses a real identity manager, coordinator, state store, and on-disk catalog. Tests are queued behind normal host capacity; completion is required before merge. No runtime behavior changed in this proof-only commit.

Fixture review confirmed auth lives in AgentServer middleware, so the integration fixture now mounts that real middleware before createRoutes. It therefore exercises the actual authenticated pipeline rather than asserting against an unauthenticated router.
