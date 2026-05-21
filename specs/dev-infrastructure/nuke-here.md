---
title: "Nuke command — project-local mode"
slug: "nuke-here"
author: "echo"
eli16-overview: "specs/dev-infrastructure/nuke-here.eli16.md"
review-convergence: "2026-05-21T14:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-21T14:00:00Z"
review-report: "docs/specs/reports/nuke-here-convergence.md"
approved: true
---

# Nuke command — project-local mode

## Problem statement

`instar nuke <name>` exists for STANDALONE agents (those at
`~/.instar/agents/<name>/`). It stops the server, removes auto-start,
backs up secrets, unregisters from the agent registry, and deletes the
agent directory.

There is no equivalent for PROJECT-BOUND installs (the result of
`npx instar setup --framework codex-cli` inside a project directory).
Today the only way to uninstall is `rm -rf` of the various artifacts
the install places in the project: `.instar/`, `.claude/` (or `.codex/`
for Codex installs), `.mcp.json`, plus the optional identity shadows
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`. Plus the auto-start plist, the
running tmux server, the agent-registry entry, and the secret backup —
none of which are visible in the project directory and all of which an
operator would forget on a manual `rm -rf`.

For testing the install/uninstall/reinstall loop on a fresh clone like
`instar-codey`, this gap is acute: every cycle requires the operator to
remember a multi-path teardown that's easy to get wrong.

## Proposed design

Add a `--here` flag to `instar nuke`. When set, the command operates on
the project-local install in the current working directory (or `--dir`
override) instead of a standalone agent.

The `<name>` positional argument becomes optional: it's required for
the standalone form and forbidden for the `--here` form.

### What `--here` removes

1. **Tmux server** for the project (`<projectName>-server`) and any
   spawned `<projectName>-*` sessions, exactly as the standalone form
   does. Project name comes from `.instar/config.json`'s `projectName`
   field, falling back to `path.basename(dir)`.

2. **Auto-start configuration** for that project name, via the existing
   `uninstallAutoStart(projectName)` helper.

3. **Secret backup** via `SecretManager.backupFromConfig` so that a
   subsequent `npx instar setup` in the same directory auto-restores
   bot tokens, dashboard PIN, etc., matching the standalone nuke flow.

4. **Agent registry entry** for the directory path, via the existing
   `unregisterAgent(dir)` helper.

5. **Filesystem artifacts** in the project directory:
   - Always deleted (instar-owned, opaque to the operator):
     - `.instar/` (config, state, hooks, scripts, jobs, memories)
     - `.claude/` (Claude framework: hooks, skills, settings, scripts)
     - `.codex/` (Codex framework: equivalent install dir, if used)
     - `.mcp.json` (instar-managed playwright MCP wiring)
     - `instar.config.json` (legacy config location, present on older agents)

   - Conditionally handled (may pre-exist in the project):
     - `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` — identity shadow files
       that instar's installer writes (when the host framework is
       Claude / Codex / Gemini respectively). These files may also
       exist before instar was installed (e.g., a project that already
       had a CLAUDE.md). The rule:
         - If the file is **tracked by git at HEAD with no working-tree
           diff** → it was committed before this install. Leave it.
         - If the file is **tracked by git at HEAD with a diff** →
           instar modified it. `git checkout HEAD -- <file>` to restore
           the pre-install version.
         - If the file is **untracked** (no `.git` or not tracked) →
           instar created it. Delete.

### Safety

1. **Refuses to run inside the instar source repo.** If `package.json`
   exists in the target dir and reports `name === "instar"` and
   `src/cli.ts` is present, the command exits non-zero with an
   explanation. This guards against an operator running `instar nuke
   --here` inside the instar source checkout.

2. **Refuses to run when no install is present.** If
   `.instar/config.json` does not exist in the target dir, the command
   exits non-zero with the expected-path message.

3. **Explicit confirmation prompt** by default, identical pattern to
   the standalone nuke. `--yes` skips it (still requires `--here` to
   target project-local mode, so no accidental bare `--yes` ever
   matches a project-local install).

4. **Plan-before-action display.** Lists every artifact path that will
   be removed (or restored, for git-tracked-modified files) before
   asking for confirmation. Operator can see exactly what will happen.

### CLI surface

```
instar nuke <name>              # standalone agent (unchanged)
instar nuke --here              # project-local install in cwd
instar nuke --here --dir /path  # project-local install in /path
instar nuke --here --yes        # skip confirmation
```

Bareword `instar nuke` (no args, no `--here`) prints usage and exits 1.

## Decision points touched

- Adds one operator-intent SIGNAL (`--here` flag) to an existing CLI
  surface.
- Adds two AUTHORITY checks: source-repo refusal (constant check on
  `package.json`'s `name` + `src/cli.ts` presence) and install-presence
  check (constant check on `.instar/config.json`).
- The pre-existing-vs-instar-added decision on identity-shadow files
  delegates to git as the AUTHORITY (`ls-files --error-unmatch` +
  `status --porcelain`). No new heuristic, no new ambiguity surface.

## Open questions

None. The surface is small, the safety posture mirrors the standalone
flow that's already shipped, and the git-based decision for shadow
files reuses the only tracking authority that already exists in the
project.

## Out of scope

- Network-side cleanup (Threadline trust entries, MoltBridge bindings).
  These are user-data the operator may want to keep across reinstalls;
  the secret backup pattern already covers the credential half. If we
  later decide to clean up network identities too, that's a follow-up
  PR with its own spec.

- Dry-run mode. The confirmation prompt already shows the full plan;
  adding a separate `--dry-run` flag adds CLI surface for marginal
  value. Reconsider if testing reveals confusion.
