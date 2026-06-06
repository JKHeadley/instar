---
bump: patch
audience: agent-only
maturity: stable
---

## What Changed

SafeGitExecutor (the single funnel for destructive git operations) now
enforces per-agent identity isolation: when the target repository has a
repo-local `user.name` + `user.email` (every agent worktree and configured
agent home), inherited `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment
variables from the spawning shell are stripped, so the repo-local agent
identity is authoritative by construction. Repositories without a local
identity keep the previous host-identity fallback unchanged. This is
increment P3a of Phase-3 per-agent credential isolation (the Caroline
identity-bleed infra-gap trio, CMT-1125 gap 1).

## What to Tell Your User

Nothing user-facing changes. This closes a quiet risk on shared machines:
previously, if the shell that launched an agent carried another person's
git identity in its environment, commits made through instar's git machinery
could be attributed to that person. Now the agent's own configured identity
always wins inside its repositories, so work is attributed to the agent that
actually did it.

## Summary of New Capabilities

- Funnel-level identity isolation: repo-local identity beats inherited
  environment identity for all destructive git operations routed through
  SafeGitExecutor.
- New internal helper repoHasLocalIdentity with per-directory caching,
  exported for tests.

## Evidence

tests/unit/SafeGitExecutor.test.ts — 5 new tests including the literal
Caroline-replay (funnel commit under a fully polluted environment lands as
the repo-local identity, author and committer both asserted); both sides of
the local-identity boundary covered; 43/43 green in-file; clean tsc.
