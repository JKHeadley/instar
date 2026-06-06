---
bump: patch
audience: agent-only
maturity: stable
---

## What Changed

Phase-3 increment P3d (per-agent credential isolation, Caroline infra-gap
trio): the SafeGitExecutor funnel now records its identity-resolution
decisions — inherited identity stripped in favor of the repo-local agent
identity, or host identity injected for repos without one — to an
append-only audit file, and the server takes a one-line credential
coherence sample at every boot comparing the agent's repo-local identity
against the machine's other identity surfaces (inherited identity env vars,
machine-global gitconfig, gh CLI auth-state presence). Signal-only by
construction: a write failure never affects a git operation and a broken
sample never blocks boot.

## What to Tell Your User

Nothing changes in day-to-day behavior. On shared machines there is now a
permanent record of every moment another person's identity tried to ride
into the agent's git work and was kept out, plus a quick health note at
startup if the machine's identity surfaces disagree with who the agent is
supposed to be. This is the visibility that was missing during the original
identity-bleed incident.

## Summary of New Capabilities

- Credential-resolution audit at .instar/audit/credential-resolution.jsonl
  with per-process flood control.
- Boot-time credential coherence sample with a single console warning when
  identity surfaces diverge; never blocks boot.
- Same audit-dir and disable overrides as the existing destructive-ops
  audit.

## Evidence

tests/unit/credential-resolution-audit.test.ts (10), tests/integration/
credential-resolution-funnel.test.ts (3, including the observed Caroline
replay through a real funnel commit), tests/e2e/credential-coherence-boot.test.ts
(4, real AgentServer.start on the production path). Regression canaries
SafeGitExecutor + GitSync + no-silent-fallbacks all green; clean tsc.
