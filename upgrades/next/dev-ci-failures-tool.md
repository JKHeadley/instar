# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Adds `instar dev:ci-failures <pr>` — a contributor/agent dev command that prints a
PR's **exact failing tests** (`file:line` + the assertion message) by reading the
GitHub **check-run annotations API**.

**Why this exists (a real friction → infrastructure).** In some environments
`gh run view --log` / `--log-failed` return zero bytes, which makes a red CI run
undiagnosable from the terminal — you can see *that* shards failed but not *which*
test. The check-run *annotations* endpoint
(`/repos/:owner/:repo/check-runs/:id/annotations`) still returns the failing
`path:line` + assertion even when the log endpoint is empty. This command wraps
that workaround so a contributor (or an autonomous agent shepherding its own PR)
gets the precise failure instantly instead of re-discovering the trick mid-run.

**What it does:** resolves the PR's head SHA → lists its FAILED check-runs →
prints each one's test-level failure annotations, de-duplicating the identical
failure that the node-20 / node-22 shard pair both report. It drops CI-runner
noise (the `.github/...` annotations and the generic `Process completed with exit
code N`). Read-only — it only calls `gh` GET endpoints; it never mutates anything.
Exit 0 even when failures are found (it's a diagnostic, not a gate); exit 1 only on
an operational error (PR unresolvable / API failure).

Pairs with `instar dev:preflight` (#716) as the contributor dev-loop toolkit.

## What to Tell Your User

Nothing required — it's a developer/agent tool for working **on** Instar. When a PR's
CI goes red, `instar dev:ci-failures <pr>` prints the exact failing tests instead of
an unreadable log.

## Summary of New Capabilities

- `instar dev:ci-failures <pr> [--repo owner/repo]` — print a PR's exact failing tests
  (file:line + assertion) via the GitHub check-run annotations API. Read-only.

## Evidence

- Built from a recurring mid-run friction: `gh run view --log[-failed]` returned 0 bytes
  on this environment across multiple PRs (#716/#717/#718); the annotations API was the
  reliable path to the failing test+line.
- Tests: `tests/unit/devCiFailures.test.ts` — the pure `extractFailureLines` (keeps real
  failures; drops warnings / `.github` / `Process completed` noise; truncates long
  messages) + `runDevCiFailures` with injected `gh` deps (red PR → prints the test;
  shard-pair dedup; green PR → "No failed checks"; unresolvable PR → exit 1; build/lint
  failure with no test annotations → a helpful note).
