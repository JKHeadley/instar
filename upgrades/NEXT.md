# Upgrade Guide — v1.2.8 (nuke --here for project-local installs)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**New: `instar nuke --here` removes a project-local install.**

`instar nuke <name>` has always handled standalone agents (the ones
at `~/.instar/agents/<name>/`). There was no equivalent for the
project-bound install method — the result of `npx instar setup`
inside a project directory. Removing one of those required a manual
multi-path `rm -rf` of `.instar/`, `.claude/` (or `.codex/`),
`.mcp.json`, and the identity-shadow files, plus the invisible parts:
the tmux server, the launchd plist, the agent-registry entry, the
secret backup.

`instar nuke --here` collapses that into one command. Run it inside
the project directory and it:

1. Stops the `<projectName>-server` tmux session and any spawned
   `<projectName>-*` sessions.
2. Removes the launchd / systemd auto-start entry for that project.
3. Backs up secrets (Telegram token, dashboard PIN, etc.) so a
   subsequent `npx instar setup` in the same directory auto-restores
   them, identical to the standalone reinstall flow.
4. Unregisters the directory from the agent registry.
5. Removes filesystem artifacts:
   - Always: `.instar/`, `.claude/`, `.codex/`, `.mcp.json`,
     `instar.config.json`.
   - For `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`: git decides.
     Tracked-clean → kept (pre-existing). Tracked-modified → restored
     to `HEAD`. Untracked → deleted.

Safety:
- Refuses to run inside the instar source repo (checks `package.json`
  name and `src/cli.ts` presence).
- Refuses to run when `.instar/config.json` is absent.
- Confirmation prompt by default; bypassed with `--yes`.

Spec: `specs/dev-infrastructure/nuke-here.md`.
ELI16: `specs/dev-infrastructure/nuke-here.eli16.md`.
Side-effects review: `upgrades/side-effects/feat-nuke-here.md`.

## What to Tell Your User

If you want to test installing instar a few different ways in a
project directory, there is now a built-in uninstall mode that runs
inside the project. It tears down everything instar installed in one
shot. Files you had committed before the install are kept (or
restored from git HEAD), so it is safe to run on a repo that already
had its own identity-shadow files.

## Summary of New Capabilities

- New CLI mode: `instar nuke --here` (project-local install teardown).
- Standalone form `instar nuke <name>` unchanged.

## Evidence

14 new unit tests in `tests/unit/nuke-here.test.ts` cover the source-
repo refusal check (four cases), the shadow-file classifier (four
cases of pre-existing-vs-instar-added-vs-untracked-vs-modified), and
the end-to-end filesystem teardown against tmpdirs (six cases
including the missing-config refusal path). All pass locally and in CI.

Manual end-to-end verification will run against the `instar-codey`
test clone after publish.
