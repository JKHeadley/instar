# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**`instar join` can now join a mesh into a directory you choose.** Joining with
a git URL used to always clone into a folder named after the repo in the current
directory, ignoring any directory you specified. Now `instar join <url> --code
<code> --dir <path>` clones and joins into `<path>`. Without `--dir`, behavior is
exactly as before.

This fixes the directory-targeting half of the init→join confusion noted in the
multi-machine bootstrap robustness spec, and is the foundation an automated
two-machine test harness needs to join a mesh into a specific throwaway home.

## What to Tell Your User

Nothing to configure. If you join a second machine to a mesh, you can now choose
exactly which folder it joins into by adding a directory option to the join
command. If you do not pass one, joining works exactly as it did before.

## Summary of New Capabilities

- `instar join <url> --code <code> --dir <path>` — join a mesh into a chosen
  directory (the `-d`/`--dir` option). For a git URL without `--dir`, the join
  still lands in a folder named after the repo, unchanged.
- `resolveJoinDir(repoUrl, options)` (new pure module `src/commands/joinDir.ts`)
  — the directory-targeting decision, fully unit-tested.

## Evidence

- `tests/unit/joinDir.test.ts` (12 tests): git/SSH/tunnel URLs crossed with
  `--dir`/no-`--dir`, relative-dir resolves absolute, plus `isGitCloneUrl`
  discrimination. Every no-`--dir` path is asserted byte-identical to the prior
  behavior (non-breaking). `tsc --noEmit` clean.
- Spec: MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC §1.3 (approved 2026-05-27).
