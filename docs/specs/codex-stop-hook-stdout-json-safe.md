---
title: Codex autonomous-loop Stop hook — stdout must be JSON-only
slug: codex-stop-hook-stdout-json-safe
status: approved
review-convergence: 2026-05-31T05:00:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h autonomous deploy mandate (topic 13435).
  This is a live-test-found bug that BLOCKS safe enablement of the #28 codex autonomous-loop
  driver: with the flag on, the hook's approve paths echoed plain text to stdout and codex
  rejected it ("invalid stop hook JSON output"), failing the Stop hook on every terminal stop.
  Found by driving Codey through a real autonomous task over Telegram (the mentorship loop),
  exactly the class of defect a unit test misses and a live run catches. Justin was watching
  and directed proceeding with the live test.
second-pass-required: false
second-pass-status: n/a-bugfix-with-regression-test
---

# Codex autonomous-loop Stop hook — stdout must be JSON-only

## Problem

The shared `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` is registered for both
Claude (`settings.json`, no args) and codex (`.codex/hooks.json`, `--codex`). For Claude, a
Stop hook may print human-readable text to stdout in the approve case (Claude surfaces it to
the user) and exit 0. For **codex**, a Stop hook's stdout MUST be either empty or a single
valid decision-JSON object — codex rejects any other stdout as "invalid stop hook JSON
output" and marks the Stop hook FAILED.

The hook's four terminal-approve paths (duration expired, emergency stop, completion condition
met, completion promise detected) each `echo` a "✅/⏰/🛑 Autonomous mode: …" line to stdout
before `exit 0`. Under codex (`IS_CODEX=1`) with the loop flag on, reaching any of these on a
real stop produced the failure. Confirmed live (2026-05-31): a codex session finished a task,
met its completion promise (line 426 echo), and its pane showed
`Stop hook (failed) — error: hook returned invalid stop hook JSON output`.

The existing unit test only covered flag-on WITH an active job that BLOCKS (the one path that
legitimately emits JSON to stdout), so it never exercised an approve/exit path under codex.

## Design

Add `emit()` immediately after the `--codex` detection:
`emit() { if [[ "$IS_CODEX" == "1" ]]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi; }`

Replace the six approve-path `echo` calls (lines for duration-expired ×2, emergency-stop,
completion-condition, completion-promise ×2) with `emit`. In codex mode these now go to
stderr (codex ignores stderr); in Claude mode they stay on stdout (byte-identical behavior).
The `{"decision":"block", …}` JSON is printed directly (never via `emit`), so it always
reaches stdout in the one case codex expects output. The restart-resume audit line already
appended to a file, and other diagnostics already used `>&2` — no other stdout writers exist.

## Migration parity

The migration `migrateAutonomousStopHookTopicKeyed` re-deploys the bundled hook only when the
deployed copy LACKS the marker. The prior marker `CODEX_LOOP_ENABLED` is already present in
every #28 install (including the buggy one), so it would wrongly skip them. The marker is
bumped to `codex-stdout-json-safe` (present only in the fixed hook) so existing codex agents
re-deploy the fix; customized hooks (no stock fingerprint `Autonomous Mode Stop Hook`) are
still left untouched.

## Safety

- Claude path byte-for-byte unchanged (approve messages still on stdout; verified by a test
  asserting the Claude approve-path still writes "Emergency stop detected" to stdout).
- The fix only moves codex-mode approve text from stdout→stderr; it changes no decision logic.
- Worst case if `emit` were wrong: an approve message is missing from a log — never a wrong
  block/approve decision.

## Test plan
- Unit (`autonomous-stop-hook-codex-gate.test.ts`): codex approve-path (emergency stop) emits
  NO non-JSON to stdout (regression); Claude approve-path still writes it to stdout; the four
  pre-existing gate cases (dark default / disabled / enabled-blocks / Claude-unaffected) stay
  green. 6 tests.
- Migration (`PostUpdateMigrator-autonomousStopHook.test.ts`): old/stock hooks still upgrade to
  the bundled (fixed) hook; idempotent on the new marker. 7 tests.
