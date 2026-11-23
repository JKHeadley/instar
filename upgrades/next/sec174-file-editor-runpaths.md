# The dashboard file editor's never-editable list covers more files that get run

<!-- bump: patch -->

## What Changed

SEC-174, a file editor fence gap. The dashboard file editor (`POST /api/files/save`) now also refuses to save anything under `.worktrees/`, the boot wrapper `.instar/instar-boot.*` in every extension, and any file named `package.json` or `.npmrc` at any depth (matched on the file name, any case). These files run without an execute bit, so the execute-bit check does not catch them. On Windows, which has no execute bit, the boot wrapper is covered only by this change. Viewing every one of these files is unchanged, and the reader shows them as not editable.

## What to Tell Your User

- **Editor fence**: "The file editor on your dashboard still opens everything, but it no longer saves the agent's development copies, its start-up file, or package manager settings."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| The editor refuses development checkouts, the boot wrapper and package manager files | Automatic |

## Evidence

- `tests/unit/sec174-file-editor-runpaths.test.ts`: through the real save route, a script and a source file in a development checkout, the boot wrapper in two extensions, and `package.json` and `.npmrc` at the root and nested are each refused and left unchanged. The files are written without an execute bit. Case and separator variants are covered, look-alike names such as `package-lock.json` stay editable, and the reader marks a fenced file not editable.
- `tests/e2e/file-viewer-e2e.test.ts`: a `package.json` inside an editable folder is refused on the real routes.
