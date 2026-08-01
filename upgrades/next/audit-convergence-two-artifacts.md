# Audit convergence now closes the learning loop

<!-- bump: minor -->

## What Changed

Every audit report that claims convergence must now preserve two distinct artifacts: the concrete fix or prevention path, and a causal meta-insight explaining the blind spot that let the problem escape. The report must also record whether the relevant Standards Registry article was created, amended, or deliberately left unchanged. Stable article IDs, digest-bound metadata, staged/CI snapshot checks, and a repository-wide inventory make counterfeit or stale claims fail closed while keeping an honest `no-change` response available.

## What to Tell Your User

Converged audits now explain both what was fixed and what the system learned from missing it. If the existing standard was already adequate, the audit says so explicitly instead of inventing a new rule, and repeated enforcement gaps become visible to reviewers.

## Summary of New Capabilities

- Enforces a sixth convergence condition covering causal blind-spot analysis and the constitutional response.
- Corroborates created/amended standards responses against the exact staged or pull-request change.
- Supports a loud, evidence-bearing `no-change` path and inventories repeated classes in CI.
- Upgrades the built-in iterative-audit skill for existing agents without overwriting customized copies.

## Evidence

- `tests/unit/write-audit-convergence.test.ts`
- `tests/unit/audit-convergence-reports.test.ts`
- `tests/unit/instar-dev-precommit-audit-staging.test.ts`
- `tests/unit/PostUpdateMigrator-auditMetaArtifact.test.ts`
- `tests/unit/standards-registry-asset.test.ts`
