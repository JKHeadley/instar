# Side-Effects Review — Suppressed-uncaught stack capture

**Version / slug:** `uncaught-suppressed-stack-capture`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier-1 — additive diagnostic helper + one log-line change; no control-flow/decision change)`

## Summary of the change

The server's `uncaughtException` handler suppresses an allowlist of isolated errors
(HTTP double-response, Slack reconnect, standby read-only write) and logs `err.message`.
For the recurring `Cannot set headers after they are sent` race the message has no location
(thrown in node internals), so the offending route is un-findable. Added
`shouldLogStackForUncaught(err)` to `uncaughtExceptionPolicy.ts` — logs the full stack the
first time a given stack is seen, message-only thereafter. The handler appends that stack
when the helper returns true. `isNonFatalUncaught` (the suppress-vs-crash decision) is
unchanged.

## Decision-point inventory

1. **Dedup key = full `err.stack` (not top-N frames).** For an HTTP double-response the
   top frames are always node's http internals; only the deep application frame separates
   one route from another, so the whole stack is the right key. Errs toward surfacing more
   distinct origins (good for diagnosis), not fewer.
2. **First-occurrence-only logging (vs. always / rate-limited count).** These races fire
   ~10–20×/hour; logging the stack every time would flood. Once-per-origin gives the route
   exactly once (sufficient to fix the real bug). Chosen over a time-window rate-limit
   because the goal is "reveal each origin once," not "sample volume."
3. **Bounded tracking (clear past 200).** A pathological variety of distinct stacks can't
   grow the Set without limit; clearing re-surfaces stacks after the cap, which is benign
   (a little extra logging) and far better than unbounded memory.

## 1. Behavior / safety

No change to which exceptions crash vs. continue — `isNonFatalUncaught` and the FATAL
branch are untouched. The only effect is additional (bounded) log output on the
already-suppressed path. Cannot introduce a crash (the helper is pure + guarded for
non-Error/stackless input → returns false).

## 2. Log volume

Net REDUCES noise risk vs. a naive "always log stack": one stack per origin, then
message-only. The first-occurrence stacks are a small, finite set (the handful of
double-respond origins + the other allowlisted errors).

## 3. Blast radius / reversibility

One new pure function + one log-line edit in the handler. Fully reversible (revert both).
No schema/config/route/external surface. Memory: one process-local bounded `Set<string>`.

## 4. Tests

`tests/unit/uncaughtExceptionPolicy.test.ts` (existing isNonFatalUncaught suite unchanged) +
a new `shouldLogStackForUncaught` block covering: first-logs-then-suppresses, same-stack
fresh-Error still deduped, distinct-origin each surfaced once, non-Error/stackless → false,
reset re-surfaces, and the cap-bound clear path. 10 tests pass.
