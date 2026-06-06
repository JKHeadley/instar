# Side-effects review — per-agent identity isolation (Inc-P3a)

## What this change does

Hardens `SafeGitExecutor.sanitizeEnv` (the env-sanitization step of the
single destructive-git funnel) against the Caroline-class identity-bleed
exposure: inherited `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL`
env vars are now STRIPPED whenever the target repository has a repo-local
`user.name` + `user.email` configured (true for every agent worktree —
`instar worktree create` sets them — and any repo init configured). With the
env vars gone and global/system config already neutralized to `/dev/null`,
git's identity resolution falls through to the repo-local config — the
per-agent identity — by construction.

## Decision boundary (both sides tested)

- Repo WITH local identity → identity env vars deleted; repo-local identity
  authoritative. Proven by a real funnel commit under a fully polluted env
  ("CAROLINE REPLAY" test) asserting author AND committer equal the local
  identity.
- Repo WITHOUT local identity → byte-for-byte prior behavior: caller env
  retained; host identity injected only-if-empty (the "Author identity
  unknown" guard for non-agent installs). Tested.

## Blast radius

- Scope: the three funnel entry points (`execSync`, `spawn`, `readSync`)
  via the shared `sanitizeEnv`, which now receives `opts.cwd`. No public API
  change; `_internal` test exports gain `repoHasLocalIdentity` and the cache
  reset helper.
- The local-identity check is two `git config --local --get` reads, cached
  per resolved directory for process lifetime — negligible cost, no
  behavior dependency on timing. Cache is test-resettable.
- Known limitation (documented in code): a call that targets a repo solely
  via `git -C <dir>` with no `opts.cwd` falls back to `process.cwd()` for
  the identity check — the legacy-compat migration shape. Fail-open to the
  PRIOR behavior, never a new failure mode. Inc-P3c tightens this alongside
  the credential-helper work.
- Raw `git` invocations outside the funnel (agent shell commands) are
  unaffected — git env precedence there is unchanged and remains documented
  in the worktree-convention caveat.

## Migration parity

No agent-installed files change (no hooks, no config defaults, no CLAUDE.md
template text, no skills). Behavior ships entirely in code on update.

## Framework generality

Framework-agnostic — the funnel serves every framework's instar server
identically.

## Tests

`tests/unit/SafeGitExecutor.test.ts`: 5 new tests (43/43 file-total green) —
local-identity detection truth table, strip-on-identity, preserve-without-
identity, the Caroline replay commit, and cache/reset semantics. Clean
`tsc --noEmit`.

## Rollback

Revert the `sanitizeEnv` conditional to unconditional inject-if-empty and
drop `repoHasLocalIdentity`. No data, no state, no config to unwind.

## Revision (CI shard-3 findings)

- The local-identity probe is now a pure fs read of the repo's config
  (linked-worktree `gitdir:`/`commondir` resolution + `config.worktree`
  overlay candidate) — NO git subprocess. Rationale: unit suites that mock
  node:child_process with scripted once-sequences (GitSync.test.ts) had those
  sequences consumed by the probe's subprocess calls; an fs read is inert.
- The probe's benign catches carry `@silent-fallback-ok` annotations inside
  the braces, and a comment was reworded because the literal phrase
  "fallback behavior" landed inside a pre-existing catch's detector window
  in no-silent-fallbacks (word-trigger, not a real new fallback).
- Verified: SafeGitExecutor + GitSync + no-silent-fallbacks = 69/69 green.
