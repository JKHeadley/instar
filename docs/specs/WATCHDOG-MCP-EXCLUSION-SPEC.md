---
slug: watchdog-mcp-exclusion
status: converged
review-convergence: 2026-04-19T20:35:00Z
approved: true
approved-by: justin
approved-at: 2026-04-19T20:50:00Z
---

# Watchdog MCP Exclusion — Token-boundary coverage

## Problem

The `SessionWatchdog.EXCLUDED_PATTERNS` list carries two regexes that catch long-running MCP stdio servers so the watchdog does not kill them. The lookaheads used to define "end of the mcp token" cover `$`, whitespace, `/`, and `.` — but not `@`. As a result, npm version-pinned invocations like `npm exec @playwright/mcp@latest` or `foo-mcp@1.2.3` escape the exclusion and get SIGTERM'd once they pass the stuck-command threshold.

Observed live: `watchdog-interventions.jsonl` logs a level-1 Ctrl+C followed by level-2 SIGTERM on `npm exec @playwright/mcp@latest` at 2026-04-19T20:16:12Z (session `echo-session-robustness`).

## Principle

Signal vs authority: EXCLUDED_PATTERNS is a brittle detector that holds pass-through authority on an irreversible kill action. Prior review (`watchdog-user-comfort.md` §4) accepted this as a safety carve-out: brittle exclusion is permissible when the default action is destructive and the cost of an over-block is "watchdog lets a stuck process run longer." This change extends coverage of that same carve-out; it does not move authority.

## Design

Extend both MCP exclusion regex lookaheads to accept `@` as a token boundary in addition to the existing `$ \s / .` set:

- `/(?:^|[\s/@])[\w.@-]+-mcp(?:-server)?(?=$|[\s/.@])/`
- `/(?:^|\s)[@\w./-]+\/mcp(?=$|[\s/@])/`

Add a comment above the regex block listing the accepted boundary chars so future extenders know the precedent.

## Scope and non-scope

- **In scope:** `@version` suffix (npm convention). Covers `@latest`, `@1.2.3`, `@next`, etc.
- **Out of scope (for now):** docker-style `:tag` (e.g. `mcp:latest`) and pip-style `==ver` (e.g. `mcp==1.0`). Not observed in production; will extend when a live case justifies.

## Acceptance criteria

1. `npm exec @playwright/mcp@latest` is excluded from watchdog kills.
2. `some-other-mcp@2.0.0` is excluded.
3. Pre-existing exclusions (workspace-mcp, claude-in-chrome-mcp, payments-mcp, etc.) still excluded.
4. Negative cases (`tail -f`, `python3`, `vitest`, `echo mcp is fun`, `helper --mcpcfg=x`) still NOT excluded.
5. Second-pass reviewer concurs no catastrophic backtracking and no credible new over-block surface.

## Rollback

Two-character change. Revert in a hot-fix patch; no persistent state shape change.

## Evidence

- Live log entry: `.instar/watchdog-interventions.jsonl` at `1776654972394`.
- Test coverage: `tests/unit/SessionWatchdog-mcp-exclusion.test.ts` — 21 tests (2 new for `@version`).
