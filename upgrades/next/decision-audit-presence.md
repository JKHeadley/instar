<!-- bump: patch -->

# PR gate: in-scope changes must carry their decision-audit record

## What to Tell Your User

Nothing user-visible — contributor CI. Pull requests that change gate-scoped code now fail fast if the local pre-commit gate never ran for them (the silent-bypass case), with a message that says exactly how to fix it.

## Summary of New Capabilities

- `decision-audit-gate` CI check: a PR touching src/scripts/.husky/skills code must include a decision-audit record (per-entry file post-#827, or a legacy jsonl modification as transition grace). Bot + release-cut PRs exempt.
- `.gitignore` now ignores a symlinked `node_modules` too (trailing-slash patterns only match real directories).

## What Changed

New `scripts/decision-audit-presence-check.mjs` (pure evaluator + CLI) and `.github/workflows/decision-audit-gate.yml`. The in-scope predicate mirrors `scripts/instar-dev-precommit.js`.

## Evidence

Live bypass this detects (2026-06-05): three build worktrees created with raw `git worktree add` had no husky shim — `git commit` ran zero hooks, so a full night's worktree commits carried no decision-audit records and nothing noticed (root fixed in #829; this is the structural backstop). Pinned by `tests/unit/decision-audit-presence-check.test.ts` (9 tests: scope predicate both sides, name-status parsing incl. renames, per-entry evidence passes, legacy-grace passes, the bypass shape FAILS with the actionable husky/`npm run prepare` message, docs-only passes, bot/release exemptions). CLI self-test green on an empty diff.
