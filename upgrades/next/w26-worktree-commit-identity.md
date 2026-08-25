---
change_type: fix
---

## What Changed

`instar worktree create` no longer stamps a made-up commit identity into every worktree it creates.

`InstarWorktreeManager.setLocalGitIdentity` wrote `Instar Agent (<agent>)` / `<agent>@instar.local`
unconditionally. That address is linked to no account, so GitHub's
`require_extra_approval_for_unattributed_changes` fires on any pull request containing those commits
and a human approval becomes a required step in the release chain — not because anything was
reviewed, but because the author field was a placeholder that had quietly become permanent.

The manager now hardcodes no domain and resolves the identity in order: `git.commitIdentity`
`{name,email}` from the agent config, else the agent repo's own `user.name` / `user.email`, else it
**refuses to create the worktree**, naming the missing setting.

The refusal is the substance of the change, not an edge case. Replacing the fake domain with a real
one was considered and rejected: it swaps one invented identity for another and leaves the same shape
in place — a step reporting success while the effect it exists to produce, a commit anyone can trace
to a person, never happens.

`PostUpdateMigrator` carries the matching documentation change, plus a dedicated idempotent migration
for it. The Worktree Convention section is installed add-if-absent, so agents that already carry it
would otherwise keep reading the removed promise indefinitely. That migration deliberately writes no
identity of its own — it cannot know one, and inventing one is exactly what this change removes.

## Evidence

A brand-new clone, read from inside itself, reports the configured identity rather than a minted one;
the first commit made from it is authored by that identity. Reading an existing worktree proves
nothing — a worktree keeps whatever it was stamped with at creation, so it shows the old address even
after a correct fix, and the verification has to come from a fresh clone.

15 unit tests over the resolver: configuration beats repo inheritance, whitespace is trimmed, six
malformed-config shapes fall through rather than stamping a broken identity, and the must-fail
control asserts that with nothing configured it refuses, invents no address (no `@` at all in the
result), and cannot be rescued by `GIT_AUTHOR_*` / `GIT_COMMITTER_*` in the environment.

5 unit tests over the migration: it refreshes the stale paragraph, leaves the rest of the document
untouched, is byte-identically idempotent on a second run, introduces no email-shaped literal
anywhere in the section, and does not double-write on a document that never carried the section.

The integration test's identity assertion is replaced rather than relaxed — it now asserts the
inherited identity *and* that the address does not contain `instar.local`, so a regression to a
minted address fails.

Full suite on a clean checkout carrying exactly these files: 3168 files passed, 49,964 tests passed,
0 failed, runner `EXIT=0`.

One defect found during the work, worth recording because it is invisible from the outside:
`SafeGitExecutor.readSync` classifies the bare `config <key>` shape as destructive — it cannot
distinguish a config read from a config write — so the rung-2 read must use `config --get <key>`. A
first draft without `--get` resolved silently to "no identity found" and would have shipped a tool
that refuses *every* worktree. Eight failing tests caught it; the reason is commented at the call
site.

## Known Limits

The resolver checks that an identity was configured, not that it is linked to a GitHub account —
which is the property the branch ruleset actually tests. An operator can configure an address that
belongs to nobody and get a green worktree that still trips the rule at pull-request time. Verifying
that would mean a network call to GitHub inside worktree creation: wrong layer, wrong failure mode.
The release gate owns that question and already catches it.

Existing worktrees are untouched and keep the identity they were created with.

This is deliberately per-machine. Configuring the identity on one machine does not configure it on
another; each resolves against its own config and its own repo, and each refuses independently until
configured. That is intended — an identity is an operator choice per install — but an operator
running several machines must set it on each. The refusal names the missing setting, so this is
discovered by being told rather than by a mystery.

## What to Tell Your User

If your agent creates working copies of a codebase to do its work, those copies used to sign their
commits with a placeholder email address at a domain that does not exist. GitHub then refused to
merge that work until a person clicked approve — not because anyone had reviewed it, but because it
could not tell who wrote it. Your agent now uses an address you actually configured, and if you have
not configured one it stops and tells you exactly which setting is missing instead of making one up.

Most people need to do nothing. If the agent's copy of the code already has a git name and email set,
which is the normal state because git asks for those the first time you commit, it simply inherits
them. If you want the agent to commit as something specific, there is now a commit-identity setting
in the agent's configuration, and it takes priority over everything else.

If you run your agent on more than one machine, this is set per machine. Configuring it on one does
not configure the others, and each one will tell you if it is missing.

## Summary of New Capabilities

- Worktrees inherit a real, configured commit identity instead of a placeholder, so agent-authored
  work no longer forces a human approval click purely to establish authorship.
- `git.commitIdentity` `{name,email}` in the agent config sets that identity explicitly.
- Worktree creation refuses, loudly and by name, when no identity is configured anywhere — rather
  than inventing one and failing later at the pull request.
