# Worktrees — How an instar agent should create them

> **Authoritative reference** for the agent worktree convention. The seed
> `CLAUDE.md` and `MEMORY.md` link here. The `instar worktree create --help`
> output points here. If you are an instar agent asking *"how do I create a
> worktree?"*, read this page.

## The rule (one line)

```
instar worktree create <branch>
```

Never `git worktree add` into the shared instar checkout. Never hardcode
another agent's name in a worktree path.

## Why

The macOS sandbox can revoke filesystem access to anything outside the
agent home **mid-session** with no in-session recovery path. Every read or
write returns `Operation not permitted` — including from `node`, `python3`,
the `Read` tool, and `git`. The only path the sandbox cannot revoke is the
agent's primary working directory: `~/.instar/agents/<agent>/`.

`instar worktree create` places the worktree at
`~/.instar/agents/<agent>/.worktrees/<slug>/` and refuses any other
destination — that's the whole point of the convention.

## What the command does

1. Resolves the **agent home** from `INSTAR_AGENT_HOME` (set by the agent
   launcher) or by walking up from the current directory looking for
   `.instar/AGENT.md`. The resolved path is validated against the
   `~/.instar/agents/` regex and the machine's agent registry; refusal is
   immediate on any mismatch.
2. Resolves the **shared instar repo** from `INSTAR_REPO` or the default
   chain (`~/Documents/Projects/instar/`, then `~/instar/`). The repo's
   `remote.origin.url` must be in the bake-in allowlist (or
   `worktree.repoUrlAllowlist` in `~/.instar/config.json`).
3. Runs `git -C <instar_repo> worktree prune` to clear dangling
   registrations.
4. Validates the branch with `git check-ref-format` and the slug with
   `^[A-Za-z0-9._-]+$` (case-insensitive collision check against existing
   `.worktrees/` entries).
5. Asserts path containment: the final worktree path's parent must
   `realpath`-equal `<agent_home>/.worktrees`, and `.worktrees/` itself
   must be a real directory (not a symlink).
6. Runs `git worktree add` (with `-b <branch> <base>` if the branch is
   new; base resolves from `origin/HEAD`).
7. Sets per-worktree `user.name` / `user.email` to
   `Instar Agent (<agent>)` / `<agent>@instar.local`. **Signing
   configuration (`user.signingkey`, `commit.gpgsign`, `gpg.format`,
   `gpg.ssh.allowedSignersFile`) is deliberately untouched** — global
   signing flows through unchanged.
8. By default, symlinks `node_modules` from the shared repo into the new
   worktree. Pass `--no-share-node-modules` for full isolation (and run
   your own `npm install`).
9. Appends one JSONL line to `<agent_home>/.worktrees/.ledger.jsonl` and
   mirrors it to `<agent_home>/.instar/audit/worktree-ops.jsonl`. The
   ledger is opened with `O_NOFOLLOW`, mode `0600`, and an `fstat`
   owner/mode check after open — a pre-planted symlink at the ledger
   path is refused.

## Common cases

- **Brand-new branch off `main`:** `instar worktree create spec/foo`.
- **Pick up an existing branch:** `instar worktree create my-existing-branch`.
- **Custom directory name:** `instar worktree create spec/foo --slug foo-experiment`.
- **No shared `node_modules`:** `instar worktree create spec/foo --no-share-node-modules`.
- **Pin against drift in `origin/HEAD`:**
  `instar worktree create spec/foo --base origin/main`.

## What's NOT covered by the command

- **Removing the worktree.** Use `git -C <instar_repo> worktree remove
  <full-worktree-path>`. (`instar worktree list` / `prune` subcommands
  are tracked as a follow-up — see R-5 in the spec.)
- **Raw `git worktree add`.** If you bypass the CLI and place a worktree
  inside the shared checkout, the lifeline detector (deferred to a
  follow-up `/instar-dev` cycle) will surface an attention-queue item on
  the next agent startup, but it will not move or delete the worktree.
- **Cross-machine sync.** Worktrees are per-machine ephemera. The
  `.worktrees/` directory is git-ignored in every agent home so it never
  enters the agent-state sync.

## Caveats

- **`GIT_AUTHOR_NAME` / `GIT_COMMITTER_EMAIL` in the environment
  override** the per-worktree identity the CLI sets. Agents that care
  about commit attribution should avoid exporting those vars.
- **Shared `node_modules` is shared state.** A concurrent `npm install`
  in the main checkout can mutate this worktree's dependency tree
  mid-test. Use `--no-share-node-modules` if that matters.
- **Pre-existing unsafe worktrees** (created before the convention or by
  raw `git worktree add`) are not migrated automatically. The operator
  can run `git -C <instar_repo> worktree move <old> <new>` per case.

## See also

- Spec: `docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md`
- ELI16: `docs/specs/AGENT-WORKTREE-CONVENTION-ELI16.md`
- Sandbox-revoke incident memory:
  `feedback_worktree_in_agent_home.md` (echo's MEMORY.md)
