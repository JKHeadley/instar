# Side-effects review — `instar nuke --here`

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — project-bound installs had no uninstall command at all;
operators had to manually `rm -rf` the install artifacts (and forget the
tmux server / launchd plist / registry entry / secret backup).

After: precisely targeted. The new mode requires explicit `--here`, runs
only when `.instar/config.json` exists in the target dir, and refuses
to run inside the instar source repo. No over-block: the standalone
form is unchanged, and operators who never pass `--here` see no
behavior change.

## 2. Level-of-abstraction fit

`nukeHere(options)` is a sibling function to the existing `nukeAgent`
in the same file. Both share the same Step 1-4 shape (tmux teardown,
auto-start removal, secret backup, registry unregister) and the same
SafeFsExecutor / SafeGitExecutor helpers for the filesystem half. The
new git-tracked-vs-untracked decision for identity-shadow files
delegates to `git ls-files --error-unmatch` + `git status --porcelain`
— the existing single source of truth for tracking state. No new
abstraction layer.

## 3. Signal vs Authority compliance

- The `--here` flag is the operator-intent SIGNAL.
- `.instar/config.json` presence is the AUTHORITY for "is there an
  install here to remove."
- `package.json` `name === "instar"` + `src/cli.ts` presence is the
  AUTHORITY for "is this the instar source repo (refuse)."
- For identity-shadow files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`):
  - `git ls-files --error-unmatch <file>` is the AUTHORITY for
    "tracked at HEAD."
  - `git status --porcelain <file>` is the AUTHORITY for "has working-
    tree diff."
  No new heuristic is invented; existing git tooling is the single
  source of truth.

## 4. Interactions with adjacent systems

- **Standalone `nuke <name>`** — unchanged. Same function, same flags,
  same prompts. The CLI route was changed from `nuke <name>` (required)
  to `nuke [name]` (optional) plus a `--here` flag — when `--here` is
  set, the positional is ignored; when `--here` is not set and no name
  is given, usage is printed and the command exits 1.

- **`uninstallAutoStart(projectName)`** in `src/commands/setup.ts` —
  reused as-is. The function is already idempotent and project-name-
  scoped; the new mode hands it the same `projectName` the install
  wrote into `.instar/config.json`.

- **`SecretManager.backupFromConfig`** — reused exactly as
  `nukeAgent` does, with the same field mapping (Telegram token, chat
  id, authToken, dashboardPin, tunnel token). This means a subsequent
  `npx instar setup` in the same directory will auto-restore secrets,
  matching the standalone reinstall flow.

- **`unregisterAgent(dir)`** — reused. Operates on the absolute
  directory path, identical contract.

- **`SafeFsExecutor.safeRmSync`** — used for every delete. The recent
  source-tree-guard carve-out (PR #294) for `<root>/.instar/` runtime
  artifacts means `.instar/` deletions inside an agent's project dir
  do not trip the guard.

- **`SafeGitExecutor`** — used for `ls-files`, `status`, and
  `checkout HEAD --`. All three are already allow-listed git ops; the
  audit trail records the new operations under
  `src/commands/nuke.ts:nukeHere-*`.

- **Tmux session naming** (`<projectName>-server`, `<projectName>-*`) —
  identical to `nukeAgent`. The new function uses the same
  `isTmuxSessionRunning` helper that already exists in the file.

## 5. Rollback cost

Trivial. One new exported function in `src/commands/nuke.ts`, one
modified CLI registration in `src/cli.ts`, one unit test, one ELI16
+ spec + this artifact. `git revert` restores the prior CLI surface;
no other surface depends on `--here`. Standalone nuke users see no
change either way.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- `instar nuke <name>` still works (positional became optional, but
  passing a name still routes to `nukeAgent`).
- `instar nuke` with no arguments now prints usage and exits 1 —
  before, commander would error out with a "missing required argument"
  message. Same exit-1 outcome, slightly clearer error.
- `instar nuke --here` is a new code path; no prior agent has it, so
  there's nothing to drift against.
- No config file changes, no template changes, no hook changes, no
  built-in skill changes — therefore no `PostUpdateMigrator` work
  needed (Migration Parity Standard not triggered: this is a CLI-only
  surface change, not an agent-installed-files change).

## 7. Authorization / Trust posture

No new authority. The command only acts on:

- The current working directory (or `--dir` override) — same scope as
  every other instar CLI command that takes a `--dir` flag.
- The launchd plist / agent registry entry / secret store keyed to
  the **projectName the install itself wrote**. The command cannot
  delete data belonging to a different project name; it reads
  `projectName` from `.instar/config.json` in the target dir.

The source-repo refusal check is an additional safety floor that
exists only to protect the instar development checkout — a one-way
guardrail with no positive authority.

## Outcome

Ship. Closes the project-local uninstall gap, matches the standalone
flow's safety posture, no new authority, no migration work, and
removes the manual-rm-rf trap operators hit today during install
testing.
