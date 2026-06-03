# Side-Effects Review — `instar dev:ci-failures`

**Version / slug:** `dev-ci-failures-tool`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier-2 — new read-only dev CLI command; no runtime/server surface, no decision boundary)`

## Summary of the change

New `instar dev:ci-failures <pr>` CLI command (`src/commands/devCiFailures.ts`, wired in
`src/cli.ts`) that prints a PR's failing tests via the GitHub check-run annotations API.
Read-only: it shells out to `gh` GET endpoints only. Adds a manifest catalog entry
(`cli:dev-ci-failures`, colon-free id per Codey's #716 convention fix) + awareness docs
(CLAUDE.md, templates.ts, site cli reference). No server route, no config, no state.

## Decision-point inventory

1. **Annotations API vs log parsing.** Chose the check-run *annotations* endpoint because
   `gh run view --log[-failed]` returns 0 bytes in some environments (the friction that
   motivated this). Annotations carry `path:line` + the assertion even when logs are empty.
2. **Diagnostic, not a gate (exit 0 even with failures).** It informs; it does not fail the
   shell on a red PR. Exit 1 is reserved for operational errors (PR unresolvable / API
   error) so a script can tell "couldn't run" from "ran, here are the failures."
3. **Shard-pair dedup.** The node-20 / node-22 shard checks report the identical failure;
   the command de-dupes by the formatted line so each distinct failure prints once.
4. **Noise filter.** Drops `.github/...` annotations and `Process completed with exit code N`
   (CI-runner artifacts, not test failures). When a failed check has no test-level
   annotations (a build/lint/type step), it prints a note rather than silently showing nothing.

## 1. Blast radius / reversibility

Additive: one new command file + one cli.ts command block + a manifest entry + doc lines.
Fully reversible. No existing behavior touched. Read-only external calls (gh GET).

## 2. Failure modes

- `gh` not installed / not authenticated → the command surfaces the gh error and exits 1.
- An annotations-endpoint hiccup for one check → that check is skipped, others still print.
- A PR with no failed checks → prints "No failed checks", exit 0.
All handled; none crash.

## 3. Manifest / docs

`cli:dev-ci-failures` added to the generator's command list → colon-free manifest id
(passes the type:name convention). CLAUDE.md and `templates.ts`'s `generateClaudeMd` were
edited in sync so `verify-deployed-templates` stays green (locally confirmed). Manifest
`generatedAt` timestamp aside, the generator output is deterministic.

## 4. Tests

`tests/unit/devCiFailures.test.ts` — pure `extractFailureLines` (both sides: keeps real
failures, drops warnings/`.github`/`Process completed`, truncates long messages, handles
missing path) + `runDevCiFailures` with injected `gh` deps (red PR prints the test; shard
dedup; green PR; unresolvable PR → exit 1; build-step-with-no-test-annotations note). 10 tests.
