# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fix, refactor, test addition, doc update, or small new safety hook -->

## What Changed

**feat(hooks): analysis-paralysis-guard — cherry-pick #1 from the GSD-Instar integration spike.**

New PostToolUse hook (`analysis-paralysis-guard.js`) that catches a real failure mode: agents stuck in a read-only loop without acting. The hook tracks recent tool calls in a small per-session state file. If five or more read-only tools (Read, Grep, Glob, WebFetch, WebSearch) fire in a row without an action tool (Edit, Write, Bash, NotebookEdit) between them, the hook injects an "act or report blocked" checklist into the next prompt.

Signal-only — the hook never blocks a tool call. It just nudges. Borrowed verbatim from gsd-executor's prompt, where it was proven against thousands of real sessions to kill the "researched the whole session, never wrote any code" trap.

This is the first of ten cherry-pick items identified during the Topic Intent Layer / GSD integration spike (see PR #332 + the comparison report v2 at topic 9413 history on 2026-05-23). Cherry-pick over runtime integration was chosen because Echo's Agent tool cannot discover GSD's specialist subagents at runtime — methodology-only is the structurally sound path.

## Evidence

- 9 unit tests, all green, materializing the hook from `PostUpdateMigrator.getAnalysisParalysisGuardHook()` and exercising the full state-machine: counter increments on read-only, counter resets on action, sessions tracked independently, malformed input never blocks, state file persists at the expected path.
- TypeScript compiles clean.
- Hook is wired into `settings-template.json` (PostToolUse, no matcher = all tools), installed via `PostUpdateMigrator.installBuiltinHooks` (always-overwrite, so existing agents get it on next `instar upgrade`), and registered in `builtin-manifest.json` so the install-state tracker accounts for it.

Side-effects review artifact: `upgrades/side-effects/analysis-paralysis-guard.md`.

## What to Tell Your User

Nothing user-visible. The hook fires silently; only the agent sees the nudge when it triggers, and only when the agent really was stuck in a read-loop. Existing agents pick it up automatically on their next `instar upgrade` (built-in hooks are always-overwrite).

## Summary of New Capabilities

One new hook script, one entry in the settings template, one entry in the built-in manifest, one migration installer call, one entry in the known-builtin-hooks list, nine unit tests. ~250 lines of code total. Quarter-day of focused work despite my pre-build "half-day" estimate (consistent with the 10x overestimate pattern Justin called out earlier this autonomous run).

Other cherry-pick items from the spike — slopcheck PreToolUse hook on package installs, `/verify-claim` skill with 4-tier verification protocol, atomic-commit + commit-format discipline in `/build` Phase 2 EXECUTE, atomic-write helper for file-backed state, goal-backward `must_haves` template, STRIDE prompt, pre-commit hook tying `src/server/*.ts` changes to matching E2E tests, SUMMARY.md deviation-tracking template, insert-time + projection-time defense-in-depth pattern doc — are deferred to follow-up PRs. Each is well-scoped, well-defined, and individually shippable.
