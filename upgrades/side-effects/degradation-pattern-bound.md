# Side effects: mark-reported feature patterns are limited to a backtracking-safe subset (SEC-125)

In plain words: `POST /health/degradations/mark-reported` compiled a caller-supplied `featurePattern` with `new RegExp` and no limit, then ran it over every stored feature name. It now goes through `compileFeaturePattern` (`DegradationReporter.ts`), which accepts at most 128 characters of letters, digits, `_`, `-`, `.`, `\.`, `^`, `$` and `|`, and refuses anything else with 400.

Tier 1. Size: 2 source files (about 25 lines), 5 new test cases in the existing route test. Effort: no spec rounds, first commit attempt.

## The defect
The route is bearer-gated, but a dashboard scoped-session token also reaches it. `^([\w.]+)+!$` measured 26 ms on a 20-character name, 87 ms on 24 and 362 ms on 26, growing about fourfold per two characters, so a normal 30-50 character feature name blocks the event loop for minutes to hours until the lifeline restarts the server.

## Over-block
Patterns using groups, character classes, repeats (`*`, `+`, `?`, `{}`), lookarounds or other escapes are now refused with 400. The shipped caller (the guardian-pulse job template in `init.ts`) sends `feature` (exact name), not a pattern. The only pattern in the repo, the test's `^unjustifiedStopGate\.`, still works. Unanchored patterns still mean "contains", which covers the old `.*` uses.

## Under-block
`markReported(RegExp)` itself still accepts any RegExp from in-process callers; none pass caller-supplied input. The 400 detail no longer includes the raw `SyntaxError` text (it was an operator-error string; the fixed message says what is allowed).

## Level of abstraction
The safe compiler sits beside `markReported` in `DegradationReporter`, so any future route taking a pattern can reuse it.

## Signal vs authority
Input validation on an existing authenticated route; it decides only whether the request's pattern is acceptable.

## Interactions
Exact-name marking is unchanged. Idempotency of `markReported` is unchanged.

## External surfaces
API callers sending a complex regex now get 400 with a message naming the allowed characters.

## Multi-machine posture
Machine-local by design: each machine marks its own degradation list.

## Rollback
Revert the commit.

## Second-pass review
**Reviewer:** independent general-purpose reviewer subagent (read-only), given the diff. It confirmed the allowlist regex is itself linear and correctly escaped, that accepted patterns are fixed-length branches (worst case name length times pattern length; it measured 0-5 ms on 200k characters), that `routes.ts` now has no caller-supplied `RegExp` left and `markReported` has no other caller, that no shipped caller (the `init.ts` template, the guardian-pulse skill) sends `featurePattern`, and that `operatorError` is still used elsewhere. It noted that a bare `|`, `.` or `^` still matches every feature, as `.*` did before. Concur with the review.
