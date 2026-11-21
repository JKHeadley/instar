# Side effects: nuke keeps project files and backs up only existing commits (spec nuke-c-min)

## Summary of the change
Spec: docs/specs/nuke-c-min.md (approved, Chief of Staff 0d86e88d). Two strict narrowings in src/commands/nuke.ts:
1. `nukeHere` no longer classifies or restores the shared project files and no longer runs `git checkout HEAD -- <file>`. It keeps CLAUDE.md, AGENTS.md, GEMINI.md, .gitignore, .claude, .codex, .mcp.json and instar.config.json untouched (presence checked with lstat only, never traversed) and deletes only the checked `.instar` folder through the unchanged SafeFsExecutor scope check. It lists the kept paths and the agent read-only review offer before confirming and in the result, including the partial-failure path. Fixes fb-c05cedd1-82b.
2. Standalone `nukeAgent` no longer runs `git add -A` or commits before the backup push. Before confirming it states that only existing commits can be pushed and runs `git --no-optional-locks status --porcelain --untracked-files=normal` (read path) to warn about uncommitted work; a status failure prints "Could not check for uncommitted changes" and blocks nothing. The push (bare `git push`, 30 s timeout, nonfatal) is unchanged; the result says "Git push succeeded" or "Could not push existing commits", each followed by "Uncommitted changes are NOT in the backup."

## Decision-point inventory
- Project file disposition — remove (Git-based keep/restore/delete classifier deleted; all eight paths kept).
- Project artifact deletion — narrow (only `.instar`).
- Backup contents — narrow (no staging, no commit).
- Backup failure policy — unchanged (nonfatal).

## 1. Over-block
Nothing new is refused. A nuke that used to clean .claude/.codex/.mcp.json/instar.config.json now leaves them; the notice says so and offers review.

## 2. Under-block
Kept files may still contain Instar instructions or hooks (stated in the notice). Uncommitted work in a standalone home is now not backed up (it was previously committed and pushed, which could publish secrets); the warning before confirmation says so.

## 3. Level-of-abstraction fit
Same command, same order; only removed steps and changed notices.

## 4. Signal vs authority compliance
No new gate. The status check is a signal (a printed warning), never authority.

## 5. Interactions
B-min (3499) teardown order, session stops and scope checks are unchanged. SafeFsExecutor checkScope still runs before teardown for the single `.instar` delete. Audit suppression for `.instar` unchanged.

## 6. External surfaces
CLI output wording changes (release note). Remote receives fewer commits (no "final backup before nuke" commit).

## 7. Multi-machine posture
machine-local-justification: hardware-bound-resource. Teardown acts on this machine's disk; the push target is unchanged.

## 8. Rollback cost
Revert the commit. No data migration; no config.

## Tests
unit: tests/unit/nuke-c-min.test.ts (17), nuke-here (13, updated to the keep policy), nuke-teardown-narrowing (53); integration tests/integration/nuke-c-min.test.ts and e2e tests/e2e/nuke-c-min.test.ts (real temp git repos, temp HOME, stubbed secrets/prerequisites, no real launchd/tmux), run by the merge line. Typecheck clean.

## Second-pass review (Codex, independent, read-only, 2026-11-19 11:4x PT)

Concur with the review. No concerns found with narrowing, notices, deletion order, scope guards, audit suppression, or removed code. Tests cover the acceptance points; sandboxing and the subprocess-only secret-loader stub are appropriate. (Static review; the reviewer did not run tests.)

## User-role proof on throwaway agents (2026-11-19 11:32-11:37 PT, Studio)

Built CLI from this branch (`node dist/cli.js`), fake HOME `/private/tmp/cmin-proof/home` (registry and agents isolated), no auto-start installed (throwaway location), clean environment (`env -i`). Live agents untouched.

- `nuke --here` on a running throwaway (project /private/tmp/cmin-proof/proj, server `proj-server` on :4791 answering /health): committed CLAUDE.md with a local edit made after install, a dangling AGENTS.md symlink, plus init's .gitignore/.claude/.mcp.json. Result: exit 0; server stopped and port closed; only `.instar` removed; CLAUDE.md, AGENTS.md (link kept, not followed), .gitignore, .claude (all file hashes), .mcp.json byte-identical before/after; the local edit still present; kept-paths list + review notice printed before and after.
- Standalone `nuke cminsolo --yes` on a running throwaway (:4792), its home a git repo pushed to a local bare remote, with an uncommitted untracked file containing a fake secret and `status.showUntrackedFiles=no`: printed "Only already committed changes can be pushed…" and "Uncommitted changes are present." before deleting, "Git push succeeded. Uncommitted changes are NOT in the backup." after; the remote received only the agent's own existing commit (a mesh lease commit its server made while running), no "final backup" commit; the fake secret is NOT in any remote commit; agent folder removed; port closed.
