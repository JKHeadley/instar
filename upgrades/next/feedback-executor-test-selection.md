# Require a real test run for feedback fixes

## Summary of New Capabilities

The feedback executor now rejects a fix when its named regression test selects no tests, even if Vitest exits successfully.

## What Changed

- The base check reports an empty test selection as `test-not-found-at-base`.
- The head check requires at least one passed test before it can publish a fix PR.
- The confined build prompt asks the session to run the exact reported test name and verify a nonempty result.

## Evidence

Live attempts on 2026-10-28 exposed a 33-skipped, zero-executed Vitest run. Focused tests cover both base and head empty selections, normal passes, and the prompt. Full-suite and CI evidence will be attached to the PR before merge.

## What to Tell Your User

Automatic feedback fixes must now show that their named regression test actually ran. Empty test selections are stopped with a clear reason.
