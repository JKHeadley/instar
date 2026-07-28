<!-- bump: patch -->

## What Changed

The `analysis-paralysis-guard` hook loaded `fs` and `path` with top-level `require`, which throws in
ESM-mode agents. Since it is a PostToolUse hook, that is an exception on *every* tool call on every
affected agent — and it installs via `PostUpdateMigrator`, so existing agents would have received it on
update.

Both are now loaded with `await import('node:…')` inside the handler, which works under both module
systems and matches the pattern the other generated hooks in this file already use.

## What to Tell Your User

Nothing — this repairs a hook before it ships, so no user ever sees the broken form.

## Summary of New Capabilities

None. The guard's behaviour is unchanged: same read-only window, same threshold, same advisory checklist.

## Evidence

- `tests/unit/no-bare-require-in-generated-hooks.test.ts`: 28/28 green; it failed on this hook before.
- Same shape as the `hook-event-reporter.js` incident (a bare `require('http')` that left ESM hosts stuck
  on a broken template) — the incident that made built-in hooks always-overwrite and produced this test.
- This PR predates the test (2026-05-23), so the pattern was never ignored — only unmeasured.
