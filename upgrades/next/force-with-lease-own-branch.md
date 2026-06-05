<!-- bump: patch -->

## What Changed

The `dangerous-command-guard.sh` PreToolUse hook blocks risky git commands,
including `git push --force` and `git push -f`. Because the match is a
case-insensitive substring, the SAFE variant `git push --force-with-lease` also
matched `git push --force` and got blocked — even though force-with-lease to one's
OWN feature/PR branch is the normal, expected way to update an amended/rebased
branch (it refuses to overwrite work the local clone hasn't seen, so it can't
silently clobber a collaborator).

This adds a narrow carve-out: `git push --force-with-lease` is allowed ONLY when it
does not explicitly target a protected branch (`main`/`master`/`develop`/`release*`).
Everything else stays exactly as strict — plain `--force`/`-f` (no lease), any
force-push to a protected branch, and all other risky patterns (`git reset --hard`,
`git clean -fd`, DB-destruction) remain blocked. The fix is applied to both
canonical deploy sources (`PostUpdateMigrator.getDangerousCommandGuard()` for
existing agents, always-overwritten on migration; and the `src/commands/init.ts`
inline copy for fresh init).

## What to Tell Your User

Nothing proactive required — this is an internal developer-experience fix to the
safety guard. If a dev session previously got blocked trying to safely update its
own pull-request branch, that false alarm is gone; force-pushing to shared
branches like main is still blocked.

## Summary of New Capabilities

None user-facing — a safety-hook false-positive fix. Agents resolving their own PRs
(rebase/amend → safe force-with-lease push to a feature branch) are no longer
incorrectly blocked, with no loss of protection against genuinely-risky force-pushes.

## Evidence

- **Reproduction:** Codey, mid-cycle on its own PR branch, ran a
  `--force-with-lease` push to update an amended commit and was blocked by the
  guard (framework-issue `52fa8663`, "force-push-guard-blocks-own-pr-amend").
  Reproduced again live this session: a Telegram status message that merely
  *quoted* the command string was itself blocked by the deployed hook.
- **Before:** `--force-with-lease` to a feature branch → BLOCKED (exit 2), matching
  the `git push --force` substring pattern.
- **After:** `--force-with-lease` to a non-protected branch → ALLOWED; plain
  `--force`/`-f`, force-to-`main`, and all other risky patterns → still BLOCKED.
- **Tests:** `tests/unit/dangerous-command-guard-force-with-lease.test.ts` — 10
  tests, both content (carve-out present in both writers) and behavioral (runs the
  actually-rendered migrator hook: ALLOW own/feature branch + no-branch + protected-
  word-substring; BLOCK plain force, `-f`, force-to-main/master, and an unrelated
  `git reset --hard`). All pass. The existing
  `dangerous-command-guard-gh-pr-merge-gate.test.ts` suite re-run green (no
  regression). `tsc --noEmit` clean.
