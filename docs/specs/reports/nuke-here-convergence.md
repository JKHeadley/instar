# Convergence Report — Nuke command — project-local mode

## ELI10 Overview

`instar nuke` already removes a standalone agent (one of those at
`~/.instar/agents/<name>/`). It stops the server, removes auto-start,
unregisters from the agent registry, and deletes the agent's folder.

There was no equivalent for the OTHER kind of install — the one you
get when you run `npx instar setup` inside a project directory like
`~/Documents/Projects/instar-codey/`. That install puts files in the
project (a `.instar/` config dir, a `.claude/` or `.codex/` folder of
hooks and skills, an `.mcp.json`, and sometimes a top-level `CLAUDE.md`
or `AGENTS.md`), starts a tmux server, installs auto-start, and
registers in the global agent registry. To remove it, you had to
`rm -rf` each path manually and remember the invisible bits (tmux,
launchd, registry, secret backup).

This change adds `instar nuke --here`. Run it inside a project
directory and it tears the whole install down — files plus the
invisible bits — in one command. The standalone form is unchanged.

The main tradeoff was deciding what to do with identity-shadow files
(`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`). Those files might already
exist before instar was installed. The fix: git is the source of
truth — tracked-and-clean files are kept (pre-existing), tracked-but-
modified files are restored to their committed version, and untracked
files are deleted (instar created them).

## Original vs Converged

The original spec proposed always deleting the identity-shadow files.
That was too aggressive — a project that had its own `CLAUDE.md`
before instar was installed would lose it on nuke. The converged spec
delegates the decision to git, which avoids inventing a new heuristic
and reuses the only tracking authority that already exists.

The original spec also didn't address the "what if I run this in the
instar source repo" footgun. The converged spec adds a refusal check
based on `package.json` `name === "instar"` + `src/cli.ts` presence.

The original CLI surface was `instar nuke <name> --here` (passing both
a name and `--here`). The converged surface drops the positional when
`--here` is set; the name comes from `.instar/config.json`'s
`projectName` field, falling back to `path.basename(dir)`. This avoids
the operator having to type the same name twice (once for `--dir`,
once as positional) and eliminates a mismatch failure mode.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self (CLAUDE.md anti-patterns, Signal-vs-Authority docs) | 3 | identity-shadow delegate to git, source-repo refusal, CLI surface dedup |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog

**Iteration 1, self-review against CLAUDE.md + signal-vs-authority docs:**

1. Identity-shadow files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) — original
   spec said "delete." Concern: project-bound install can run in a repo
   that already had these files. **Resolution**: git decides — tracked-
   clean → keep, tracked-modified → restore, untracked → delete.

2. Source-repo footgun — original spec didn't refuse to run in the
   instar source checkout. Concern: an operator running `instar nuke
   --here` in the dev checkout could wipe the `.instar/` development
   state. **Resolution**: refusal check based on `package.json` name +
   `src/cli.ts` presence.

3. CLI surface — original spec had `nuke <name> --here`. Concern: name
   duplication, mismatch failure mode. **Resolution**: positional
   becomes optional, ignored when `--here` is set; projectName is read
   from `.instar/config.json` in the target dir.

**Iteration 2, re-review:** No new material findings. Three operator-
facing decisions covered by single-source-of-truth authorities; safety
posture matches the standalone flow.

## Convergence verdict

Converged at iteration 2. No material findings in the final round.
Spec is ready for user review and approval.
