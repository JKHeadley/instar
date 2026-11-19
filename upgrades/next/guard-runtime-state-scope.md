# The file-deletion safety check starts watching a gap (no change yet)

<!-- bump: patch -->

## What Changed

The check that stops destructive file operations inside an agent's own program code had a shortcut: any path containing `/.instar/` was allowed. Every agent lives under `~/.instar/agents/<name>`, so the shortcut covered the whole agent folder.

This release adds the narrower rule: only the checkout's own `.instar/` folder, plus three named permissions for the callers that relied on the gap. It ships in **report mode**. Every delete is still decided exactly as before. The new rule only writes down where it would differ, in `.instar/state/guard-scope-diff.jsonl`.

Switching the new rule on is a separate, later decision. It needs at least 14 days of observations and the nuke fix.

## What to Tell Your User

- **Nothing changes yet:** "I've started recording where a stricter file-safety rule would disagree with the current one. Nothing is refused differently today; after two weeks of notes we decide whether to switch it on."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Guard scope differences, per machine | `GET /source-tree-guard/scope` (`?scope=pool` for all machines) |

## Evidence

Tests:
- 5 new unit files, 71 tests;
- SafeFsExecutor, trash and SourceTreeGuard, 80 tests;
- integration 2/2.

The second-pass review's three concerns were fixed and it concurred. Spec `docs/specs/guard-runtime-state-scope.md` was approved by the Chief of Staff at the round cap; it is not converged.
