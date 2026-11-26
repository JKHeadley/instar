# Side effects: file editor fence gap (SEC-173)

In plain words: the dashboard file editor's never-editable list now also covers the repository's own git folder and `.gitmodules`, and the editor refuses to save any file with an execute bit. Viewing is unchanged.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size: `src/server/fileRoutes.ts` (two list entries, a new exported `isExecutableFile`, one check in the save route, one term in the read route's `editable` flag) and 1 new unit test file.

## What changes for running agents
- **Never-editable list.** `.git/` and `.gitmodules` join the list. The existing case folding, separator folding and nested-root matching apply, so a worktree's `.git` pointer file and `.worktrees/<n>/.git/...` are covered, and a symlink into the git folder is refused through the resolved-path check. `.github/`, `.gitignore` and `.gitattributes` stay editable.
- **Execute bit.** `POST /api/files/save` returns 403 "Scripts cannot be edited from the file editor" when the resolved target has any execute bit, and `GET /api/files/read` reports `editable: false` for it. The editor cannot create links or change modes, and a newly created file is written without an execute bit. No-op on Windows.
- **Who notices.** An owner who edited a script or a git file from the dashboard. Neither was a supported use; both still open read-only.
- **Known residue (pre-existing, out of scope).** Files without an execute bit that a program interprets (for example `package.json` scripts or a `.js` file run by `node`) remain editable, as do instruction files, which are editable on purpose.

## Signal vs authority
Not applicable as a new judgment: this extends a deterministic deny list that is an invariant by design ("a dashboard credential must never yield arbitrary code execution").

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the finding and the diff), 2026-11-22. Verdict: CONCUR, no blocking items. It confirmed every spelling of the git folder is refused (case, `./`, trailing slash, backslash, symlink via the resolved path, worktree pointer file, nested copies), that save is the only write route and the config PATCH cannot widen the fence, that the ENOENT create fallback is unreachable before the fence, that the execute-bit check follows symlinks and new files cannot be executable, and that the tests fail on the old code. Non-blocking notes: interpreted files without an execute bit remain the open class (recorded above), and the save route could open and fstat the descriptor before writing, as the read route does.

## Rollback
Revert the commit. No stored state changes.

## Tests
- `tests/unit/sec173-file-editor-git-fence.test.ts` (new, 7 cases) through the real routes and a real `git init` repository.
- `tests/e2e/file-viewer-e2e.test.ts` gains two cases on the real routes: a git folder inside an editable path is refused and unchanged; a script in an editable path reads as not editable and its save is refused. Not run by hand on the M5 (standing rule); Local Verify runs it.
- Existing fence and editor tests pass unchanged: `file-editor-never-editable-bypasses`, `console-files`, `grok-build-round17-security`, `file-routes-never-served-key-material`.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. No loop or spawn added.
