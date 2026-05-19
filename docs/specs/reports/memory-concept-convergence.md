# Convergence Report — Memory (Layer-3 primitive)

## ELI10 Overview

A **Memory** artifact is one of the files that makes the agent *itself* — its identity (`.instar/AGENT.md`), its user context (`.instar/USER.md`), its learnings (`.instar/MEMORY.md`), and its per-conversation structured memory (`.instar/state/topic-memory.sqlite`). These are the canonical files that persist across sessions and machines and that frame every new conversation.

This spec defines what counts as canonical Instar Memory, how the parity rule verifies the artifacts are intact, and — importantly — why the rule deliberately *refuses* to auto-fix corruption. Memory contains your agent's identity and accumulated drift; silent regeneration would erase the intentional things you'd want to keep.

What changes for the user: nothing visible until the FrameworkParitySentinel ships. When it does, a missing or corrupted Memory artifact will surface as a structured alert pointing at the exact file and a documented repair procedure — instead of the current behavior where missing memory silently degrades agent context.

## Original vs Converged

The first draft tried to make Memory render framework-native memory files (`CLAUDE.md`, `AGENTS.md`). Convergence surfaced that this conflates Memory (the canonical artifacts) with the *loading vehicle* (the framework's instruction file). They're two different primitives: Memory owns the canonical files; InstructionFile owns the framework-native loaders that reference them.

The converged spec scopes Memory's responsibility narrowly: verify canonical artifact presence + integrity. Loading is deferred to the InstructionFile primitive (separate, comes next). This is a cleaner separation of concerns and matches the required-primitives-inventory's #5 vs #6 boundary.

The other major change: locking in `flag-only` remediation policy and a remediate() that throws with a documented repair pointer. Memory is sacrosanct — silent regeneration would erase identity drift that's often deliberate.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | abbreviated (pattern-instance reuse from Skill convergence) | 2 (loading-vs-canonical conflation, remediation safety) | Scope to verifier-only; split loading off to InstructionFile primitive; lock flag-only policy + throwing remediate |
| 2 | (converged — no material new issues) | 0 | none |

## Full Findings Catalog

**F1: Memory primitive conflates canonical artifacts with framework-native loading** — Severity: high. Reviewer perspective: integration / scalability. Original: spec proposed Memory render CLAUDE.md / AGENTS.md. Resolution: scoped Memory to canonical artifact verification only; framework-native loading is the InstructionFile primitive's responsibility (separate, next).

**F2: Auto-remediation of Memory would erase identity drift** — Severity: critical. Reviewer perspective: adversarial / security. Original: spec proposed remediate() that re-generates from template if corrupted. Resolution: locked `flag-only` policy; remediate() throws with a documented repair procedure (re-init for AGENT.md/USER.md, git-restore for MEMORY.md, backup-restore for sqlite). Corruption surfaces loudly via verify() rather than silently regenerating.

## Convergence verdict

Converged at iteration 2. No material findings in the final round. The spec is approved (pre-authorized per hybrid C autonomous-mode agreement). Memory primitive ships verifier + structured-error remediate; InstructionFile primitive (separate) will pick up the loading-vehicle work.

## Deviation note

Pattern-instance + substrate-bound abbreviated convergence — Memory's full reviewer perspectives have been baked into the canonical-source-of-truth + per-framework rendering pattern via Skill convergence. Memory's two deviations from that pattern (no rendering callsites in v0.1; flag-only policy with throwing remediate) are themselves the convergence findings, documented in the spec's frontmatter `review-deviation`.
