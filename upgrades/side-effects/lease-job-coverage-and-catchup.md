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

## Full-integration startup repair (2026-11-05)

Full integration found route construction assumed scheduler settings and coordinator manager dependencies existed. Coverage now falls back to the standard on-disk jobs catalog when scheduler settings are absent, and remains unavailable without crashing unrelated routes when identity-manager dependencies are absent. Added both boundary cases to the real HTTP integration tests. Independent second-pass review concurred: configured behavior is unchanged, unavailable dependencies grant no coverage or execution authority. Fresh full-suite evidence remains required.

The same full integration run also exposed identity-capable coordinator adapters without EventEmitter methods. Role listener registration and cleanup now use optional method calls; real coordinators retain the same event subscription. A third boundary test verifies signed coverage remains alive and cleanup is safe without those adapter methods. Independent review concurred.

## Agent awareness and migration parity completion (2026-11-05)

Fresh templates and existing full/reference-layout instructions now share one coverage/catch-up guide, including API use, registry lookup, proactive triggers, and job-building rules. Existing AGENTS/GEMINI shadows receive the same guide. Add-only stable markers preserve custom instructions and make updates idempotent. Shadow insertion runs after legacy section copying so copied guidance is not duplicated. New real template/migrator/reference/shadow tests cover actual delivery at a non-default port and preservation of operator notes. Independent review corrected the API pointer to pool.coverage and concurred with the final ordering. This adds agent awareness, not execution authority; final tests remain required.

Focused awareness verification passed: 39 real template/migration/reference-layout tests, zero failures. TypeScript noEmit passed. Full regression suite remains the merge gate.

## Scheduler-awareness interaction repair

The final full unit run caught a real migration collision: new coverage URL references suppressed the older scheduler pool bullet. Match that bullet's own marker rather than any occurrence of its URL. No legitimate content is rejected; documents without a scheduler section still receive coverage guidance without gaining a scheduler bullet. This is add-only documentation migration, grants no execution authority, changes no replicated job state, and uses the existing update path on every machine. The adjacent migration remains idempotent. Rollback is a code revert; no data repair is needed. Independent review concurred. The existing migration assertions now distinguish a scheduler bullet from coverage and registry references. Focused repair and controller-convergence tests passed 538/538; real reference-layout tests passed 35/35. The preserved full run reported three failures before this repair; fresh final full-suite verification is still required.

## Host process-scan compatibility repair found by the final suite

The final full run exposed a deterministic diagnosis-restart failure. A direct real ps measurement returned ERR_CHILD_PROCESS_STDIO_MAXBUFFER at 1,038,731 output bytes in 93ms. The default 1 MiB allowance made an otherwise readable table unknown. The existing recovery scan now allows at most 8 MiB and keeps its two-second timeout. Output errors, overflows, ambiguous identities and live unknown children still prevent cleanup and new admission. This fixes the failure at the process-discovery layer without changing its authority or matching rules. No new under-block issue identified; legitimate tables over 8 MiB remain intentionally unknown rather than consuming unbounded memory. On each machine this scan is machine-local by design because process IDs belong to that host. There is no copied credential or replicated-state change. Rollback is a code revert; no data migration is needed.

Real child-executed ps fixtures cover a listing over 1 MiB and an overflow over 8 MiB. The overflow must preserve the durable intent and input file and refuse a distinct new attempt as busy. Independent review concurred and requested those explicit no-cleanup/no-new-admission assertions; they are included. Build passed. The new focused tests are pending normal host capacity, not claimed as passed. The earlier real-host existing lifecycle test failed in both the full suite and an isolated rerun before this repair; both logs remain preserved. A separate standards CLI/library mismatch passed all 38 tests on untouched rerun, with its cause still unknown. Final full-suite and exact-head verification remain required.

## Second-pass review

**Reviewer:** /root/review_transfer_resume

Concur with the side-effects assessment of the incremental repairs and this artifact. This review covers the bounded process scan, its explicit overflow safety assertions, the migration interaction repair, bootstrap compatibility, and awareness delivery reviewed during this session. Earlier implementation-review statements above remain prior recorded review history.

## Current verification evidence — 2026-11-05

The combined runtime source at 4009a9d28cbcf15086d1021d79513111f0f9e427 passed the full unit lane (58,591 tests) and full integration lane (5,841 tests), with zero failures. The new real subprocess buffer boundaries also passed both cases. The earlier pending-test paragraphs describe their point in the chronological repair history. Full E2E and required exact-head verification remain pending. This review-name/trace correction changes no runtime source or tests and does not replace either remaining gate.
