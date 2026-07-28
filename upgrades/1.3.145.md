---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; live-test-found bug blocking #28 enablement — Justin watching)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — codex autonomous-loop Stop hook no longer fails on approve (stdout must be JSON)

Live-test finding (2026-05-31): when the codex autonomous-loop driver (#28) flag is on and a
codex session reaches a terminal stop (e.g. it finished the task and met its completion
promise), the shared `autonomous-stop-hook.sh` printed a human-readable approve message
("✅ Autonomous mode: Completion promise detected…") to **stdout**. Codex treats ANY non-JSON
on a Stop hook's stdout as a failure and logged "Stop hook (failed) — invalid stop hook JSON
output" on every such stop. The unit test missed it because it only exercised the flag-on path
WITH an active job that BLOCKS (the one path that legitimately prints JSON) — never an
approve/exit path.

The fix: in codex mode the hook routes all human-facing approve/status text to **stderr**
(new `emit()` helper); the only thing it ever writes to stdout is the `{"decision":"block"…}`
JSON. Claude behavior is unchanged (it still surfaces those messages on stdout to the user).

## Summary of New Capabilities

- `emit()` in `autonomous-stop-hook.sh`: codex mode → stderr, Claude mode → stdout. Applied to
  the duration-expired, emergency-stop, completion-condition, and completion-promise approve
  paths (the 4 places that wrote plain text to stdout).
- Migration marker bumped `CODEX_LOOP_ENABLED` → `codex-stdout-json-safe` so existing #28
  installs (which already carry `CODEX_LOOP_ENABLED`) re-deploy the FIXED hook. Customized
  hooks (no stock fingerprint) are still left untouched.

## What to Tell Your User

If you run a codex agent with the autonomous-loop driver turned on, it will no longer log a
failed Stop hook when a run finishes — the hook now keeps its codex output strictly to the
machine-readable form codex expects. Nothing to configure.

## Evidence

- Repro (live): a codex session completed a 3-step task, hit its completion promise, and the
  pane showed "Stop hook (failed) — error: hook returned invalid stop hook JSON output".
- Fix: `emit()` routes approve/status text to stderr in codex mode; stdout carries only the
  block-decision JSON.
- Regression test: `tests/unit/autonomous-stop-hook-codex-gate.test.ts` — codex approve-path
  (emergency stop) emits NO non-JSON to stdout; Claude approve-path STILL writes it to stdout
  (both sides; 6 tests pass).
- Migration parity: `tests/unit/PostUpdateMigrator-autonomousStopHook.test.ts` (7 tests pass);
  marker bump re-deploys the fixed hook to existing codex agents.
- `tsc --noEmit` + `npm run lint` clean.
- Spec: `docs/specs/codex-stop-hook-stdout-json-safe.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/codex-stop-hook-stdout-json-safe.md`.
