# Side-Effects Review — Self-Coherence spec DRAFT (docs-only)

**Spec:** docs/specs/self-coherence-parallel-work-attribution.md (`status: draft-for-convergence`, `approved: false`). **Parent:** Cross-Machine Coherence — One Agent.

**This is a DOCS-ONLY change.** No src/, scripts/, .husky/, or SKILL.md files are touched. The deliverable is a spec draft + its plain-English ELI16 overview, opened as a DRAFT PR for the operator to review and steer. There is no code, no wiring, no behavior change, and nothing ships dark — because nothing ships at all yet.

## Files

- `docs/specs/self-coherence-parallel-work-attribution.md` — the spec draft (Problem → Root Cause → Components A–D → Phase C → Open Operator Decisions → Residual Risks).
- `docs/specs/self-coherence-parallel-work-attribution.eli16.md` — the plain-English overview that restates the two open operator decisions so the operator can decide without opening the spec.

## Blast radius

- **Zero runtime blast radius.** No code path changes. No config defaults change. No migration runs. Adding two markdown files under `docs/specs/` cannot alter any agent's behavior.
- The instar-dev pre-commit gate treats `docs/` as out-of-scope (only `src/`, `scripts/`, `.husky/`, and `skills/**/SKILL.md` are in-scope), so this commit passes the gate's empty-in-scope early-exit. The trace + this artifact + the next-fragment are authored anyway as hygiene and as the requested deliverables.

## Risk + mitigation

- **Risk:** the draft is mistaken for an approved design and someone builds against it. **Mitigation:** `approved: false` + `status: draft-for-convergence` in frontmatter, a prominent draft banner at the top of both docs, and the PR is opened as a DRAFT (`gh pr create --draft`). The spec must go through /spec-converge and earn operator approval before any /instar-dev work touches src.
- **Risk:** the cited code symbols drift and the spec's grounding goes stale. **Mitigation:** every cited symbol was verified present at authoring time (MachineIdentity.ts, IdentityManager.ts, BootSelfKnowledge.ts, SubscriptionPool.ts, InstarWorktreeManager.ts, ParallelActivityIndex.ts, PoolActivityView.ts, ParallelWorkOverlap.ts, CoherenceReviewer.ts, claim-provenance.ts, CoherenceGate.ts, PrincipalGuard.ts). The spec composes these primitives rather than redefining them.

## Migration parity

- N/A — no agent-installed files (settings.json hooks, config defaults, CLAUDE.md sections, hook scripts, built-in skills) change. A docs-only spec draft reaches existing agents through the normal repo, not through the update path.

## Rollback

- Delete the two markdown files. There is nothing else to revert.

## Tests

- N/A for this commit — no code changes, so no test tiers apply. The spec itself enumerates the tests-to-write for each of components A–D (unit / integration / E2E / wiring-integrity / audit), to be authored when (and if) the operator approves the design and the build proceeds under /instar-dev.

## Open operator decisions carried forward

1. How the operated-by-me GitHub-login set is established (self-asserted / auto-discovered / both) — RECOMMENDED: both, self-asserted as trust anchor + auto-discovery as advisory enrichment.
2. Sequencing A→B (identity-hygiene-first) vs B→A (registry-first) — RECOMMENDED: A-first.
