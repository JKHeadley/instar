# Self-Coherence — SelfIdentityRegistry + parallel-work attribution (spec DRAFT for operator review)

<!-- bump: patch -->

<!--
  NOTE: docs-only. A spec DRAFT + its plain-English ELI16 overview, opened as a DRAFT PR.
  No src/scripts/.husky/SKILL.md files touched. status: draft-for-convergence, approved: false.
  The design composes existing primitives (MachineIdentity, IdentityManager, BootSelfKnowledge,
  SubscriptionPool, InstarWorktreeManager, ParallelActivityIndex, PoolActivityView,
  ParallelWorkOverlap, CoherenceReviewer, PrincipalGuard) — all verified present at authoring.
  Nothing ships. The PR exists so the operator can react to and steer the design, and answer the
  two open decisions, before any /instar-dev build touches src.
-->

## What Changed

A new spec DRAFT addresses a major self-coherence gap the operator flagged: the agent ran parallel autonomous tracks whose PRs landed on the instar repo, then narrated its own parallel work in chat as the work of "a maintainer" — inventing an external party for itself. The spec names the root cause (no identity signal separates the agent's own other hands from the operator from a genuine outsider, so the agent defaults to inferring "a maintainer") and proposes four components: identity hygiene that signs every commit path with a distinct agent identity, a SelfIdentityRegistry with an isSelf(actor) lookup composed from existing primitives, a unified "all my hands" read view, and a signal-only confabulation review lens. It carries two open operator decisions, each with a recommended default.

## What to Tell Your User

You caught me describing my own parallel work as if a separate maintainer had done it — when all of it was me. I have written up a plain-English plan for fixing that so I actually recognize my own concurrent hands instead of inventing a stranger for them. It is a draft for you to react to and steer, not a finished decision, and it asks you two questions: how I should learn which GitHub login counts as me, and whether to clean up the commit signatures before or after building the lookup. Nothing changes in how I work yet — this is the plan, opened as a draft for your review.

## Summary of New Capabilities

No new runtime capability — this is a spec DRAFT only (status: draft-for-convergence, approved: false), opened as a draft PR. It gives the operator a concrete artifact to react to and answer the two open design decisions before any build proceeds.

## Evidence

- The spec grounds every cited symbol against real code verified present at authoring time, and cites direct evidence of the root cause: the last 20 commits on the canonical main are authored with a personal git identity (and github-actions), with zero carrying the per-worktree agent identity — proving the leaked commits bypassed the per-worktree identity-set.
- No tests in this commit (docs-only). The spec itself enumerates the tests-to-write for each of components A through D.
