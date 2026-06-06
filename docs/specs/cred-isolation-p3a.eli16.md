# Per-agent identity isolation, increment P3a — ELI16

## What this is

When several AI agents (and several people) share one computer, git has a
dangerous habit: an environment variable like `GIT_AUTHOR_NAME`, set by
whatever shell happened to launch the agent, silently outranks the identity
configured inside the agent's own repository. That is exactly how the
"Caroline" incident started — an agent on a shared Mac picked up another
person's identity from machine-global state and carried it as its own.

Instar already routes every dangerous git command through one funnel
(SafeGitExecutor). This change teaches that funnel a simple rule: **if the
repository being operated on has its own local identity configured — which
every agent worktree and agent home does — that local identity always wins.**
Any `GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables that leaked in from the
spawning shell are stripped before git runs, so git falls through to the
repo's own config: the agent's name, the agent's email.

## What changed, concretely

One file of logic (`src/core/SafeGitExecutor.ts`):

1. A new check asks the target repository: "do you have a LOCAL `user.name`
   and `user.email`?" (read with `git config --local`, cached per directory).
2. If yes — the four identity environment variables are deleted from the
   child environment. The repo-local identity is now the only identity git
   can see.
3. If no — nothing changes from before: the funnel keeps injecting the host
   machine's identity as a fallback so ordinary (non-agent) installs don't
   suddenly fail with "Author identity unknown".

Five new unit tests cover both sides of the boundary, including a literal
"Caroline replay": a commit made through the funnel with a fully polluted
environment (`GIT_AUTHOR_NAME=Caroline`, etc.) and the test asserts the
commit lands as the repo's local identity — not Caroline.

## Why it's safe

The change is scoped to the funnel and conditioned on the repo having a
local identity. Repos without one keep byte-for-byte the previous behavior.
Raw `git` commands an agent types in a shell are not affected (they never
were the funnel's job); this closes the path where instar's own machinery
could be tricked into committing as the wrong principal. No config flag, no
route, no migration — pure hardening at the single choke point that already
exists for exactly this kind of rule.

## Addendum — how the repo is probed (CI-hardening revision)

The "does this repo have its own identity?" check reads the repository's
config file directly from disk (following the worktree pointer file when the
repo is a linked worktree) instead of spawning a git subprocess. Two reasons:
it is faster and has no side effects, and — discovered by CI — several unit
tests script the exact sequence of git subprocess calls they expect, so an
extra probe subprocess from inside the funnel would silently shift those
sequences and break unrelated tests. Reading the file can't interfere with
anything.
