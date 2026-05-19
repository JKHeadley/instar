# Convergence Report — Parity Sentinel trust wiring + backfill

## ELI10 Overview

Two changes that together turn the parity sentinel's documented "mirror-trust" policy into actual behavior. The sentinel now consults Instar's adaptive trust system when deciding whether to auto-fix drift, and a one-shot migration on update seeds a default trust entry for every existing agent so the v0.1 remediate-by-default behavior is preserved.

## Original vs Converged

The audit identified a critical regression: the sentinel shipped with `remediationPolicy: 'mirror-trust'` as the documented gate, but the implementation just checked a boolean flag. Trust was never consulted. The fix wires `shouldRemediate()` to `AdaptiveTrust.getTrustLevel('parity-sentinel', 'modify')` and the PostUpdateMigrator seeds the trust entry at `'log'` level so existing agents don't silently lose remediation.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check (against canonical principles index) | 0 contradictions; 0 deferrals | None |

## Manual lessons-aware findings

See the `lessons-engaged:` frontmatter and the manual lessons-check table in the spec body. Engaged P1 (Structure>Willpower) via in-code trust gate, P2 (Signal vs Authority) by promoting AdaptiveTrust to the authority while keeping the mirror-trust enum as the signal, P3 (Migration Parity) via the PostUpdateMigrator seed, P4 (Testing Integrity) with 11 new unit tests across the wiring + migration layers, P10 (Comprehensive-First) by shipping the full fix in v0.1 with zero recurrence-risking deferrals.

## Convergence verdict

Converged at iteration 1. Tactical amendment to merged primitive; no design redesign, just makes the documented policy honest. The lessons-aware reviewer (PR #260) is structurally in place for /spec-converge going forward but its content migration to deployed agents is the next task in this autonomous session.

## Deviation note

Tactical amendment running under autonomous-mode hybrid-C pre-authorization. Manual lessons-check applied transparently in the spec body against the canonical index — same bootstrap pattern PR #259 and PR #260 used. Subsequent specs in this autonomous session will exercise the lessons-aware reviewer end-to-end once the SKILL.md content migration lands.
