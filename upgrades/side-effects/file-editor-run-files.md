# Side effects: the dashboard file editor refuses more files (SEC-144)

In plain words: more paths that decide what runs can be read but not saved in the dashboard's file editor, including their copies inside worktrees.

Tier 1. Size: `src/server/fileRoutes.ts` (the never-editable list and its matcher), `dashboard/console/files-model.js` (the page's copy of the list), the instar `CLAUDE.md` file-viewer line, 1 test file extended.

## What changes
- `POST /api/files/save` (the only write route; it checks the requested and the resolved path) and the read route's `editable` flag refuse `.claude/settings.json`, `.claude/settings.local.json`, `.instar/hooks/`, `.instar/scripts/`, `.instar/jobs.json`, `.instar/jobs/user/`, `.instar/jobs/schedule/` (job manifests: what runs, when, enabled), `.mcp.json`, `.codex/`, `.gemini/` and `.husky/`, case-folded.
- The matcher now also matches each entry inside a nested project root (for example `.worktrees/<name>/.claude/settings.json`), because sessions run inside worktrees and load that copy's hooks and settings. A file such as `tests/fixtures/.claude/settings.json` is therefore also read-only in the editor.
- The job route (`POST /jobs/:slug/save`) checks the slug and a version token, not what the job runs, so fencing job files in the editor is defence in depth, not a hard boundary: the same token can still save jobs through that route.
- Checked for legitimate editor users before closing: the dashboard's schedule editor saves jobs through `POST /jobs/:slug/save`, not the file editor; forking and unforking shipped jobs have their own routes; the Playwright profile route edits `.claude/settings.json` through its own route. `.claude/config/settings.json` and other files under `.claude/` stay editable.
- Not changed here, noted for follow-up: dashboard session tokens get no step-up for file saves; the save audit log takes its source address from the first `X-Forwarded-For` entry; the save path lacks the read path's inode check.

## 6b. Operator-surface quality
- `dashboard/console/files-model.js` `NEVER_EDITABLE` gains the same entries, each with a plain reason the Files page shows ("Jobs decide what runs; edit them on the Schedule page." and similar). The unit test that keeps it a subset of the server list (`console-files`) passes. Importing tests: `console-files`, `console-file-search-preview` (unit, run), `console-home-lifecycle` (e2e) and `console-static-serving` (integration), run by the pre-push and Local Verify tiers.
- (1) Primary action: unchanged; the Files page still leads with browsing and opening files, and a read-only file still opens for reading. (2) No raw internals: the new reasons are plain sentences, not paths or codes as primary content. (3) Destructive actions: none added; this only removes a save option for some files. (4) Phone width: each reason is one short sentence, shown in the existing read-only notice.

## Signal vs authority
Narrows which files the editor writes; nothing that saves through it today is affected.

## Rollback
Revert the commit.

## Tests
- `file-editor-never-editable-bypasses` (+1 case covering every new entry, several cases and worktree copies; controls extended), `console-files`, `console-file-search-preview`, `fileRoutes-never-served`, `file-routes-never-served-key-material`: 78 pass.

## Second-pass review

**Reviewer:** independent Claude reviewer subagent, two rounds. Round 1 was blocking: job manifests (`.instar/jobs/schedule/`) still decided what runs and were editable, and copies inside worktrees were not matched; it also listed `.codex/`, `.gemini/`, `.husky/` and the stale page list. All applied. Round 2 concurred; its notes are applied too: Windows separators folded to `/` before matching, the CLAUDE.md line names the exact job folders, the code comment matches the defence-in-depth wording, and tests cover a sibling backup (`.mcp.json.bak`) and a Windows-style path.

Left as noted: the Files page's own read-only reason matches only top-level entries, so a worktree copy shows the generic "outside the folders you have allowed editing" reason (the server still refuses the save); dashboard session tokens still get no step-up for file saves.
