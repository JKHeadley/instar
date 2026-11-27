# Side effects: file editor fence gap, run paths (SEC-174)

In plain words: the dashboard file editor no longer saves files a program runs that carry no execute bit: anything in a development checkout under `.worktrees/`, the boot wrapper `.instar/instar-boot.*`, and `package.json` or `.npmrc` at any depth. Viewing is unchanged.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size: `src/server/fileRoutes.ts` (two list entries, a name list, a new exported `hasNeverEditableName`, one line in `isNeverEditable`), 1 new unit test file, and one end-to-end case.

## What changes for running agents
- **Never-editable list.** `.worktrees/` and the prefix `.instar/instar-boot.` join the list. The existing case folding, separator folding and nested-root matching apply.
- **Names at any depth.** `package.json` and `.npmrc` are matched on the last path segment, in any case. Look-alikes stay editable: `package-lock.json`, `my-package.json`, `.npmrc.example`, and a folder named `package.json`.
- **Every chokepoint.** The save route, the read route's `editable` flag, the link route and the `editablePaths` config check all use `isNeverEditable`. Save and read check the resolved path too, so a link under another name is refused.
- **Who notices.** An owner who edited a manifest, a package manager setting or a development checkout from the dashboard. None of these was a supported use, and all still open read-only. Docs and notes inside `.worktrees/` also become read-only, which was accepted when the fence was approved.
- **Deliberately not fenced.** Tool config files (for example `vitest.config.*`) and instruction files, which are editable on purpose.

## Signal vs authority
Not applicable as a new judgment: this extends a deterministic deny list that is an invariant by design ("a dashboard credential must never yield arbitrary code execution").

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the finding and the diff), 2026-11-22. Verdict: CONCUR, no blocking items. It confirmed:
- every chokepoint consults the predicate;
- case, backslash, `./`, trailing-slash and symlink spellings are refused, and a `.worktrees` linked outside the project is refused by path validation;
- the boot wrapper's real names in the source (`.cjs`, `.js`, `.sh`) are all covered by the prefix;
- look-alikes stay editable;
- the tests fail on the previous commit.

It suggested a link-alias test, which was added. It also noted that the link route has no dedicated test, but it shares the same predicate.

## SEC-178 folded in (backup snapshots)
- Change: `.instar/backups/` joins NEVER_EDITABLE_PREFIXES. BackupManager keeps its snapshots at `<stateDir>/backups`, and a restore copies every manifest file back to `<stateDir>/<file>`, fenced ones such as `jobs.json` included. The manifest hash covers only the file list and total size, so editing a snapshot copy needed no manifest change.
- Over-block: none expected. Nobody edits a snapshot from the phone; snapshots stay viewable and restorable. The nested match also fences a `.instar/backups/` inside a worktree copy, which is fine.
- Under-block: an agent whose stateDir is not `.instar` keeps its snapshots elsewhere; the default layout is `.instar`. Not done here, and recorded on the ledger for a later pass: keying the manifest hash over file contents, and the sibling copy paths (skill rendering from `.instar/skills/`, git-sync pull, job fork). Skipping fenced destinations at restore was declined because restoring the jobs list is the point of a restore.
- Review: an independent Sonnet reviewer CONCURRED with no blocking items. It confirmed save is the only write route and checks both the requested and resolved path, PATCH /api/files/config also consults the fence, and case, dot-segment, separator, link and nested variants are covered. Its non-blocking suggestions (derive the prefix from a non-default stateDir; key the manifest hash over contents) are recorded above as not done here.

## Rollback
Revert the commit. No stored state changes.

## Tests
- `tests/unit/sec174-file-editor-runpaths.test.ts` (new) through the real save and read routes, with files written without an execute bit.
- `tests/e2e/file-viewer-e2e.test.ts`: a `package.json` inside an editable folder is refused. Not run by hand on the M5 (standing rule); Local Verify runs it.
- `tests/unit/sec178-file-editor-backups-fence.test.ts` (new) through the real save route and the real BackupManager restore. Three of four cases fail without the fence.
- Existing fence and editor tests pass unchanged: `sec173-file-editor-git-fence`, `file-editor-never-editable-bypasses`, `console-files`, `file-routes-never-served-key-material`.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. No loop or spawn added.
