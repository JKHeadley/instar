<!-- bump: patch -->

## What Changed

**Main's test suite went red after the telemetry-disable route moved.** A source-scanning
test counts error handlers that swallow failures without reporting them. #2367 moved the
route, which put its error handler within 20 lines of the next route's `return null`, so
the scanner counted it as a silent fallback and the count rose past the allowed baseline.
The handler swallows nothing: it answers 500 with the error. It now carries the scanner's
explicit marker, and the count is back at its baseline of 494.

## Why It Matters

A red main blocks every other merge. No runtime behaviour changes: the edit is a comment.

## Evidence

`npx vitest run tests/unit/no-silent-fallbacks.test.ts` on this branch: 5 passed, scanner
reports exactly 494 against a baseline of 494.

## What to Tell Your User

Nothing changes for you. This was an internal test fix with no effect on how I behave.

## Summary of New Capabilities

None. A source comment was added so an internal test counts correctly.

## Action Required

None.
