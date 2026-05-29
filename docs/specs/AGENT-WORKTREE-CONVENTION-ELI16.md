---
title: Agent Worktree Convention — ELI16
companion-spec: AGENT-WORKTREE-CONVENTION-SPEC.md
created: 2026-05-17
updated: 2026-05-17 (round 2)
---

# Agent Worktree Convention — In Plain English

## The problem in one sentence

When an instar agent makes a "scratch copy" of the shared instar codebase
(a git worktree), it sometimes puts that copy in a folder the macOS
sandbox later refuses to let the agent read or write — and there's no
way to fix it without ending the session.

## What's actually happening

Claude Code (the tool that runs each instar agent) draws a security
boundary around the agent's home folder, which is
`~/.instar/agents/<agent>/`. The agent can always read and write inside
that folder. Anywhere else, permission is granted at session start but
can be silently taken away later when something shifts — a sub-agent
launches, a hook fires, an MCP tool runs, settings get refreshed.

The shared instar source code lives somewhere else, at
`~/Documents/Projects/instar/`. That's outside the boundary. When an
agent created a worktree there to do its work, the worktree was outside
the boundary too. So mid-session the agent would lose access to its own
in-progress work with no way to recover.

This isn't theoretical — it's happened to echo multiple times, including
once tonight that stranded a real implementation cycle.

## The fix

Put the worktree somewhere the boundary can't move under us — inside the
agent's own home folder at `~/.instar/agents/<agent>/.worktrees/`. That
folder is always accessible.

Echo proved the pattern tonight by moving its stranded worktree there
and watching every test pass and every file survive.

## Why we need a spec

The pattern works for echo. But "echo has a bash script" doesn't help
any other instar agent on any other machine. We want this convention to
apply to *every* instar agent — automatically, without anyone having to
remember to set it up. That means doing five things, each small:

**1. A new command in instar.** `instar worktree create <branch>` does
what echo's script does today, but it's built into instar itself, so
every agent gets it for free after the next install. The command
refuses to create worktrees outside the agent's home — that's the
whole point.

**2. New agents are born knowing the rule.** When someone runs
`instar init` to create a new agent, the seed CLAUDE.md and MEMORY.md
mention the convention. So the rule shows up on day one.

**3. Existing agents are upgraded automatically.** When instar updates
on any machine, a migrator step runs through every agent home and
installs the bash helper, adds the `.gitignore` line, and makes sure
the `.worktrees/` folder exists with safe permissions. Nothing for the
operator to do.

**4. A detector watches for mistakes.** When an agent starts up, a
lightweight check looks at the shared instar repo's worktree list and
flags anything that isn't inside an agent's safe area. It doesn't
delete or move anything — it just surfaces the problem so it gets
fixed.

**5. The Self-Knowledge Tree learns the convention.** Any future agent
asking "how do I create a worktree?" gets the right answer back.

## What changed between round 1 and round 2 of review

The seven reviewers (four internal perspectives plus GPT, Gemini, and
Grok externally) found real things in the first draft. Big ones:

- **Hostile-CWD attack.** The original spec resolved the agent home by
  walking up from the current directory looking for `.instar/AGENT.md`.
  An attacker who could plant that file anywhere could redirect
  worktree placement. The new spec uses an env var set by the launcher
  *plus* strict validation that the resolved path is a real registered
  agent under `~/.instar/agents/`.

- **`INSTAR_REPO` trust.** Originally the spec trusted whatever path
  was in the env var. Now the candidate must contain `.git`, have a
  remote URL matching an allowlist, and have a sane `core.hooksPath`.
  Refuses otherwise.

- **The `node_modules` symlink could undo the whole fix.** Gemini
  pointed out that if the sandbox follows the symlink to resolve a
  required module, it might revoke at the *target* — recreating the
  exact failure we're fixing. The new spec defaults to no symlink.
  Operators who want sharing opt in with `--share-node-modules` and
  accept the documented caveats.

- **`.gitignore` for the agent home.** Without this, the first time
  git-sync ran on an agent home with a `.worktrees/` directory, it
  would try to upload multi-GB of foreign-repo contents into the
  agent-state repo. New spec adds the gitignore entry in the seed
  *and* in the migrator for existing agents.

- **Slug and branch validation.** Originally the spec just passed
  strings through to git. A confused or prompt-injected agent could
  use `slug="../../../etc/..."` and land the worktree *exactly* in
  the unsafe location we were trying to escape. New spec validates
  slug against a strict regex, runs `git check-ref-format` on the
  branch, and asserts the final path is inside the agent home with
  a `realpath` check.

- **Audit trail and detector promoted to v1.** Originally R-4 deferred
  detection to a follow-up. Reviewers pointed out the convention has
  zero observability without it. New spec ships the detector + an
  audit ledger in the same PR.

- **Per-worktree git identity.** Without setting `user.name` /
  `user.email` per worktree, an agent's commits would show up as
  Justin's. New spec sets identity to `Instar Agent (<name>)` /
  `<name>@instar.local` automatically.

- **Permissions.** `.worktrees/` is created `0700` so other agents on
  the same machine can't read each other's in-flight code.

## What stays the same

- Humans using `git worktree add` directly are unaffected.
- The shared instar repo keeps working exactly as before for everyone
  else (humans, CI, ad-hoc scripts).
- The bare repo at `~/Documents/Projects/instar/` is untouched.
- Pre-existing worktrees in unsafe locations keep working for non-agent
  callers. We don't try to migrate them (the detector flags them and
  the operator decides).

## What could still go wrong

- **An agent might still type raw `git worktree add` and put a
  worktree in the unsafe spot.** Possible. The detector will catch
  it on the next agent startup and surface an attention-queue item.
- **A machine that hasn't updated instar in a while won't have the
  new command.** That's why the migrator installs the bash helper
  on every update — the bridge is there as soon as any instar update
  lands on that machine.
- **The detector might be noisy at first.** ~30 pre-existing
  worktrees outside agent homes today on echo's machine. The detector
  will flag all of them on first startup. Operator either drains them
  or migrates them with `git worktree move`. One-time burst.

## Rollback

If this turns out to be wrong, revert four small commits in instar
source and let the gitignore entries stay (harmless). Total cleanup:
under 10 minutes. No data loss.

## Why this is acceptable risk

- The bash helper has been in production today and worked across
  multiple sessions.
- Nothing existing breaks because the change is purely additive (a
  new command, two new template paragraphs, one migrator step, one
  detector).
- The `.gitignore` change prevents a much worse failure mode (multi-
  GB sync corruption) than anything it could possibly introduce.
- All seven reviewers' findings from round 1 are addressed in the
  text; round 2 runs next.

## What I need from you

Read the spec and this companion. If the round 2 reviewers come back
without material new findings, I'll publish the convergence report and
ask for your approval. Otherwise I'll iterate again.

Full spec at `docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md` covers the
side-effects review framework, tests, sequencing, and five deferred
residuals (operational follow-ups, not spec gaps).

## Amendment (2026-05-29): make the pre-commit gate real in every worktree

We found a subtle hole while using the worktree convention. A new worktree can
have the tracked pre-commit script and can have Git configured to use Husky, but
still not actually run the gate. The missing piece is Husky's generated shim,
which is local ignored state. It appears after the package prepare step runs,
but a fresh worktree does not automatically contain it.

That meant a developer could commit in a fresh worktree and skip the quality
gate without intending to. The fix is to make worktree creation activate and
verify the Husky shim before returning. If the shim cannot be created, the
worktree command fails instead of handing back an unsafe checkout.

This turns the rule from memory into structure: every worktree created by the
official command starts with the pre-commit gate physically present and runnable.
