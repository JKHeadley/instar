## What Changed

- **Local Verify no longer marks a PR harness-changing because it could not load its own parser.** The skip ratchet parses changed test files with `typescript`, a devDependency. The verify child runs from the agent server's installed copy, which has no devDependencies, so `require('typescript')` failed on every PR that changed a `.test.ts` file; the classifier treated that as a diff read failure and recorded the PR harness-changing (23 of 41 runs on 2026-10-22/23, e.g. PR #2317). The parser is now resolved from the run worktree that `npm ci` just installed (a PR that changes the typescript pin is itself harness-changing), then from the installed copy; callers may inject it (`OrchestratorSeams.typescript`).
- **A parser failure alone no longer sets `harnessChanging`.** If the ratchet still cannot run and an inventoried test file changed, the record carries `skipsAdded` and `testsRemoved` (what could not be ruled out) and logs `skip-ratchet-failure`; the changed test files are the paths an independent review must cover. A real read failure of the diff still classifies the PR harness-changing, as the spec requires.

## What to Tell Your User

Ordinary changes that only touch tests are no longer mislabelled as changes to the test machinery, so they stop waiting on an extra review they did not need.

## Summary of New Capabilities

- `skip-ratchet-failure` run-log event; `OrchestratorSeams.typescript` injection point; `loadTypescript(fromDirs)` in `src/localVerify/skipRatchet.ts`.

## Evidence

- Before: `.instar/state/local-verify/runs/*.log` shows `classify-read-failure: Cannot find module 'typescript' … shadow-install/node_modules/instar/dist/localVerify/skipRatchet.js` and the record `harnessChanging: true`.
- After: `tests/unit/localVerify/orchestrator.test.ts` — a missing parser with a changed inventoried test records `harnessChanging: false, skipsAdded: true, testsRemoved: true` and logs `skip-ratchet-failure`, not `classify-read-failure`; with no inventoried test changed nothing is flagged; an injected parser is used. `tests/unit/localVerify/skipRatchet.test.ts` — `loadTypescript` resolves from a given directory before its own install and falls back when the directory has none.
