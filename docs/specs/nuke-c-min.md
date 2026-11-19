---
title: "instar nuke keeps project files and backs up only existing commits"
slug: nuke-c-min
author: echo
eli16-overview: docs/specs/nuke-c-min.eli16.md
---

# instar nuke keeps project files and backs up only existing commits

## Problem statement

`instar nuke <name>` removes a standalone agent and its home folder. `instar nuke --here` removes the Instar installation in the current project. Both stop the selected agent through the existing teardown checks before deleting its data.

Today, `--here` classifies project identity files using Git (`src/commands/nuke.ts:1334`). Dirty tracked files can be reset with `git checkout HEAD -- <file>` (`src/commands/nuke.ts:1283`). Untracked files and files outside Git can be deleted. Git lookup errors can select deletion or restoration (`src/commands/nuke.ts:1349`, `src/commands/nuke.ts:1361`). This loses user edits: feedback fb-c05cedd1-82b. The removal list also includes shared configuration paths (`src/commands/nuke.ts:53`).

Standalone nuke stages everything and creates a final commit before pushing (`src/commands/nuke.ts:1086`, `src/commands/nuke.ts:1092`). That silently chooses what enters the backup, including work the user never committed.

## Scope

STRICT-NARROWING. Chief of Staff decision 0552571a, 2026-11-19, authorizes exactly two changes: keep project files during `--here`, and remove automatic staging and committing from standalone backup. The notices below are part of those two changes.

The larger hardening, items 1-6, is parked as commitment CMT-2025 <!-- tracked: CMT-2025 -->. Rebuilding project files belongs to CMT-2020 <!-- tracked: CMT-2020 -->. Their exact texts appear at the end.

No new flags, deletion refusals, locks, scans, or stop/delete authority. Existing session selection, auto-start handling, secrets backup, registry updates, teardown order, and failure handling remain. “Only `.instar`” below limits project artifact deletion; it does not redesign those existing lifecycle steps.

## Proposed design

### 1. `--here` keep policy

Keep these project paths byte-for-byte:

- `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.gitignore`;
- `.claude`, `.codex`, `.mcp.json`, `instar.config.json`.

This holds whether tracked or untracked, dirty or clean, and with or without Git. Keep directories and their contents untouched. Keep symlinks as links, including dangling links; never traverse them. Do not create missing paths. Other project files remain untouched too.

Replace the Git-based disposition in `nukeHere` (`src/commands/nuke.ts:1167`, `src/commands/nuke.ts:1176`) with unconditional keeping. Remove its checkout path entirely (`src/commands/nuke.ts:1277`). The classifier at `src/commands/nuke.ts:1334` no longer controls this command. No Git query determines any project file's fate, so a Git error cannot change what happens to a file.

Reduce the project artifact delete plan (`src/commands/nuke.ts:1190`) to the checked `.instar` folder. Keep its current flags, operation, and audit suppression (`src/commands/nuke.ts:1204`). Keep `SafeFsExecutor.checkScope` before teardown and the execution guard unchanged (`src/commands/nuke.ts:761`, `src/commands/nuke.ts:778`). This is a smaller plan, not a new deletion allowance.

Before confirmation (`src/commands/nuke.ts:1227`), list the present kept paths by name. Use only non-traversing metadata checks of those eight names, not a content or directory scan. A metadata error may be printed as “presence unknown; left untouched”; it must not authorize a write or add a refusal. Print: “Kept project files may still hold Instar instructions or hooks. Review them yourself if you want to remove those instructions.”

Repeat the kept-path list and warning in the result, including a partial failure result after teardown starts. With confirmation skipped, still print the notice before teardown. Do not claim that keeping these files removes their Instar content or disables their hooks. Existing cancellation and deletion-failure behavior remains.

### 2. Standalone backup: no add or commit

Remove automatic `git add -A` and the automatic commit (`src/commands/nuke.ts:1085`). Push only what is already committed. Keep the bare `git push`, working directory, remote and branch selection, 30-second timeout, and position after stopping sessions (`src/commands/nuke.ts:1096`). No new remote, branch, or backup destination is selected.

Before confirmation, use the existing read-only `status --porcelain` operation, moved from `src/commands/nuke.ts:1087`, to report uncommitted changes when a Git repository exists. It covers staged, unstaged, and untracked changes. This is the required Git status check, not a new filesystem or writer scan. If status fails, say “Could not check for uncommitted changes”; do not treat failure as clean or block deletion.

Always state the backup limit before confirmation: “Only already committed changes can be pushed. Uncommitted changes are NOT in the backup and will be deleted with the agent folder.” If status reports changes, also print “Uncommitted changes are present.” Print these notices even when confirmation is skipped. Existing no-remote behavior remains (`src/commands/nuke.ts:1049`).

On push success, say “Pushed existing commits. Uncommitted changes are NOT in the backup.” On failure, say “Could not push existing commits. Uncommitted changes are NOT in the backup.” Preserve the existing nonfatal push failure policy (`src/commands/nuke.ts:1098`). The final backup wording at `src/commands/nuke.ts:1126` must reflect that outcome and must not imply a complete snapshot or a successful push after failure. No Git error adds a deletion refusal or changes the deletion target.

## Decision points touched

- **Project file disposition — invariant.** basis: irreversible-consequence. Evidence: checkout overwrites edits and the current classifier can delete untracked files. All eight paths are kept without Git-based judgment.
- **Project artifact deletion — invariant.** basis: enumerable-domain. Evidence: one target, `.instar`, through the existing scope checks. No other artifact receives delete authority.
- **Backup contents — invariant.** basis: irreversible-consequence. Evidence: automatic staging and committing publish previously uncommitted work. Nuke creates neither index changes nor commits for backup.
- **Backup failure policy — invariant.** basis: operator-ratified-exception. Evidence: the ratified scope forbids new deletion refusals. A failed status or push is reported without a new gate.
- **Notices — invariant for substance; judgment-candidate for presentation.** Kept names, possible remaining instructions/hooks, dirty status, and backup limits are required. Spacing and grouping may vary without changing those facts.

## Frontloaded Decisions

- **Keep all eight paths.** Do not infer ownership from Git, filenames, headers, or contents. No owned-block editing or restoration is included.
- **Only existing commits are pushed.** Uncommitted work can be lost when the standalone home is deleted. Say this before the existing confirmation; do not add another prompt or refusal.
- **Strict narrowing is settled.** Both changes remove existing mutation powers. There is no unresolved product decision in this draft. Review checks compliance with the ratified boundary.

## Multi-machine posture

`machine-local-justification: hardware-bound-resource`. Teardown acts on this machine's disk, sessions, and service entries. The existing Git push still reaches its configured remote, but introduces no fleet coordination or authority over another machine. A peer's project files and uncommitted work are not included.

## Testing

These are implementation acceptance tests, not tests run for this draft.

**Sandboxing, every tier:** temporary `HOME`, temporary Instar home and registry, and temporary Git repositories only. Mock secrets and service commands; never reach real launchd, systemd, or live tmux sessions. Use mocked tmux by default. Any actual tmux fixture must use a private `tmux -L <unique-test-socket>` socket on every call. Remote push fixtures use a temporary local bare repository, never a network remote.

- **Unit:** exercise all eight kept paths across clean, staged, unstaged, untracked, non-Git, and Git-error cases. Assert no checkout and no artifact deletion except `.instar`. Cover ordinary and dangling symlinks, missing paths, and metadata errors. Check required notices before confirmation, with confirmation skipped, and in success/partial results. Standalone cases assert no add/commit, unchanged push arguments and timeout, dirty warnings, unknown status, and nonfatal push failure.
- **Integration:** run `nukeHere` against temporary repositories and a non-Git project with stubbed lifecycle dependencies. Compare bytes, directory contents, symlink targets, and Git index before and after. Place symlink targets outside the temporary project but inside the sandbox and prove they stay untouched. Verify `.instar` removal and unchanged scope refusals. For standalone backup, prove the bare remote receives existing commits only; staged, unstaged, and untracked content never enters a new commit.
- **E2E:** drive the CLI initialization and confirmation path in a subprocess with temporary homes and stub service executables. Cover cancel, confirm, and skipped confirmation for both commands. Capture output order and final notices. Confirm only the intended project artifact disappears, push failures retain today's deletion behavior, and the shipped teardown checks still operate.

## Maturation plan

- **test-agent-live:** sandboxed integration and CLI fixtures above.
- **dev-agent-live:** repeat the CLI proof with a throwaway install in a temporary home; no live services or real agent data.
- **fleet:** ships on after acceptance evidence passes.
- **graduation criterion:** preserved bytes and links, only the checked artifact deleted, no automatic add/commit, and accurate notices demonstrated in all three tiers.
- **dark-window:** none; no feature flag.
- **ladder:** not applicable: this removes mutation powers and adds notices without a new capability or flag.

## Rollout

Ship both changes together. Release note: “`instar nuke --here` now keeps project instructions and shared configuration unchanged. Those files may still contain Instar instructions or hooks. Standalone `instar nuke` pushes only existing commits; uncommitted changes are NOT in the backup and are deleted with the agent folder. It no longer stages or commits your work automatically.”

> **CMT-2025** — "Nuke hardening items 1-6 (session ownership tags, one lifecycle lock, open-file writer scan, launchd disable for hand-started restarters, Linux KillMode check, backup policy beyond C-min) are PARKED, not built. Draft kept untouched at commit bcad74b16 on branch echo/nuke-hardening-spec-c (did not converge in 6 rounds). Revisit only when a real incident shows nuke stopping, restarting or deleting the wrong thing."
>
> **CMT-2020** — "Design NH-RESTORE-MANIFEST after spec nuke-hardening ships: a separately reviewed spec for restoring Instar-installed project files during nuke --here from a setup-time install manifest (before-images, generated hashes, index preservation, exact owned-block edits), never overwriting changed content and never guessing for legacy installs."

