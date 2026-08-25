# Side-effects review — worktree commit identity is resolved, never minted

**Slug:** `w26-worktree-commit-identity`
**Window:** 26, item 0(a) — the precondition, not release content
**Files:** `src/core/InstarWorktreeManager.ts`, `src/core/PostUpdateMigrator.ts`,
`tests/unit/InstarWorktreeManager-commit-identity.test.ts`,
`tests/unit/PostUpdateMigrator-worktreeCommitIdentity.test.ts`,
`tests/integration/instar-worktree-create.test.ts`

## What changed

`setLocalGitIdentity` stamped every new worktree with `Instar Agent (<agent>)` /
`<agent>@instar.local`. That address is linked to no GitHub account, so
`require_extra_approval_for_unattributed_changes` fires on the protected branch and a human
approval becomes a required step in the release chain — measured on the W25 release PR, where it
was one of four human actions.

The manager now hardcodes **no domain** and resolves:

1. `git.commitIdentity` `{name,email}` from the agent config, if usable;
2. else the agent repo's own `user.name` / `user.email`;
3. else **throw** — refusing to create the worktree, naming the missing setting.

`PostUpdateMigrator` gets the matching documentation change plus a dedicated idempotent migration,
because the Worktree Convention section is installed add-if-absent and agents that already carry it
would otherwise keep reading the removed promise forever.

## Phase 1 — principle check (signal vs authority)

**Is there a decision point?** Yes, and it is worth being precise about which kind.

The resolver decides *whether a worktree is created at all*, so it holds real blocking authority.
Under `docs/signal-vs-authority.md` that would be a violation **if the logic were brittle**. It is
not: the predicate is "did a human configure an identity, in one of two named places" — a total,
deterministic read of two explicit sources with no heuristics, no pattern-matching, no inference.
There is nothing to be brittle about, and it fails in the safe direction (refuse) rather than the
unsafe one (invent).

The design deliberately rejects the alternative that *would* have been a violation: guessing an
identity (from the agent name, a default domain, the OS user) and proceeding. That is precisely
"brittle logic holding blocking authority" — it would silently succeed with a wrong answer, which
is worse than refusing.

## Phase 4 — the eight questions

**1. Over-block — what legitimate input does this reject that it shouldn't?**
A worktree creation on an agent with neither `git.commitIdentity` nor a repo-level identity now
fails where it previously succeeded. That is intended, but it is a real behaviour change and the
honest worst case: an agent that never configured git and relied on the minted address loses
`worktree create` until it configures one. Mitigations: rung 2 catches every agent whose repo has
any identity at all (the overwhelming majority — git itself nags for this), the error names the
exact setting to add, and the failure is loud and immediate rather than deferred to a rejected PR
hours later. A malformed config (`{name}` with no `email`, wrong types, unparseable JSON) falls
*through* to rung 2 rather than failing — tested, six cases.

**2. Under-block — what does it still miss?**
It does not validate that the resolved address is *linked to a GitHub account*, which is the
property that actually satisfies the branch ruleset. An operator can configure
`nobody@example.invalid` and get a green worktree that still trips the rule at PR time. Checking
that would require a network call to GitHub inside worktree creation — wrong layer, wrong failure
mode. The resolver's job is "an identity a human chose"; whether that identity is *attributable* is
the release gate's job, and that gate already exists and already caught this.
It also does not touch existing worktrees: they keep the identity stamped at their creation. That
is why the canary must be re-run from a **new** clone; reading an old one is a false negative.

**3. Level-of-abstraction fit.**
Correct layer. The identity must be applied at the moment the worktree is created, because that is
when git's local config is written and it is the only point that knows both the target directory
and the agent home. A higher layer (the CLI shim) would have to re-derive both. A lower layer
(SafeGitExecutor) has no notion of agent identity. No smarter gate exists for this that the change
should feed instead.

**4. Signal vs authority compliance.** Yes — see Phase 1. Blocking authority, but on a total
deterministic predicate over explicit configuration, failing closed.

**5. Interactions.**
- **Signing config:** the function's pre-existing contract is that it touches `user.name` /
  `user.email` only, never `user.signingkey` / `commit.gpgsign` / `gpg.format`. Preserved, and the
  integration test still asserts the local `user.signingkey` is unset.
- **`SafeGitExecutor`:** the rung-2 read must use `config --get <key>`. The bare `config <key>`
  shape is classified *destructive* by the read funnel (it cannot distinguish a config read from a
  config write) and throws. A first draft without `--get` silently resolved to `null`, which would
  have shipped a tool that finds no identity and therefore refuses every worktree. Caught by eight
  failing tests; the reason is commented at the call site.
- **Env vars:** `GIT_AUTHOR_*` / `GIT_COMMITTER_*` still override at commit time. Unchanged, still
  documented, and a rung-3 test asserts they cannot rescue an unconfigured repo (they must not make
  it *look* configured).
- **Migration double-write:** the add-if-absent section insert and the new refresh migration could
  both touch the same document. The refresh only fires while the stale sentence is present and what
  it writes does not contain that sentence, so it cannot loop or duplicate; tested for idempotency
  (byte-identical second run) and for the never-had-the-section case.

**6. External surfaces.**
Visible to every agent that creates a worktree, and to anyone reading a resulting commit's author.
Commits from new worktrees will now be attributed to a real identity — which is the point, and is
also the only externally-observable change. No route, no wire format, no message.

**7. Multi-machine posture (Cross-Machine Coherence).**
**Machine-local BY DESIGN.** A worktree is a directory on one machine's disk and its git config is
local to that checkout; there is nothing to replicate and nothing to merge. The *inputs* differ per
machine by intention: `git.commitIdentity` lives in each machine's own config, and rung 2 reads that
machine's own repo. Consequence worth stating: configuring the identity on one machine does **not**
configure it on another — each machine resolves independently and each will refuse independently
until configured. That is the correct behaviour (an identity is an operator choice per install, and
silently inheriting one across machines is the failure mode `stateSync` deliberately avoids for
PII-adjacent records), but it means an operator running several machines must configure each. The
refusal message makes that self-diagnosing rather than silent.

**8. Rollback cost.**
Low and clean. Revert the two source files; new worktrees resume the old stamping behaviour
immediately, with no data migration, no agent-state repair, and no released artifact to unwind —
existing worktrees are untouched either way because their config was written at creation. The
CLAUDE.md refresh migration is idempotent and text-only; reverting it leaves already-refreshed
documents carrying the newer paragraph, which is harmless (it would simply describe behaviour the
reverted code no longer has — and that is exactly the drift class recorded as W26 FINDING-02, so a
revert should revert both files together, not one).

## Evidence

- Unit: `InstarWorktreeManager-commit-identity.test.ts` — 15 tests. Rung 1 wins over rung 2;
  whitespace trimmed; six malformed-config fall-through cases; **rung-3 must-fail control**
  (refuses with nothing configured, asserts no invented address and no `@` at all, and is not
  rescued by `GIT_AUTHOR_*` / `GIT_COMMITTER_*`).
- Unit: `PostUpdateMigrator-worktreeCommitIdentity.test.ts` — 5 tests. Refresh-on-stale, rest of
  document untouched, idempotent, **never writes an identity of its own** (no email-shaped literal
  survives in the section), no double-write when the section was never present.
- Integration: `instar-worktree-create.test.ts` — the identity assertion is **replaced, not
  relaxed**: it asserts the inherited identity *and* that the address does not contain
  `instar.local`, so a regression to a minted address fails the test.
- Consumer proof: a brand-new clone read from inside itself reports `Echo` /
  `echo@sagemindai.io`.
- **Full suite on a clean checkout carrying exactly these five files: 3168 files passed,
  49964 tests passed, 0 failed, runner `EXIT=0`.**
