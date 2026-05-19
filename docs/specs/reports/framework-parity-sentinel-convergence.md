# Convergence Report — FrameworkParitySentinel

## ELI10 Overview

The **FrameworkParitySentinel** is the engine that turns the parity rules we've been building (Skill, Hook, Memory in PRs #252/#253/#254) into something that actually *runs*. Each rule knows how to check whether a canonical artifact matches its rendered form — but until now, nothing was walking the registry and running the checks. The sentinel is that walker.

On a 30-minute interval (and on demand), it iterates every parity rule, lists every instance, calls `verify()` on each, and:

- If clean, moves on.
- If drift, emits a `parity:gap-found` event and (if the rule's policy says it's safe) calls `remediate()` to re-render.
- If user-edit conflict, refuses to remediate and emits `parity:remediation-refused` so the operator can resolve.

v0.1 ships the sentinel as a **building block** (class + unit tests) — HTTP routes and server.ts boot integration come in a focused follow-up PR. This matches the precedent set by the parity rule PRs: each rule shipped as a building block, with operational wiring deferred.

## Original vs Converged

The original sentinel proposal (`specs/provider-portability/13-framework-parity-sentinel.md`, 2026-05-18) was written before the rules registry existed. It proposed a flat `parityRules.ts` array under `src/monitoring/parity/` and a sentinel that owned both the rule definitions AND the scan loop.

Convergence surfaced that the architecture had already evolved past this. PRs #252/#253/#254 shipped a proper rules registry under `src/providers/parity/`, with per-rule `ParityRule` implementations. The sentinel doesn't need to own rule definitions — it just consumes the registry.

The converged spec rewrites the architecture: thin consumer, registry-walker, narrow v0.1 scope (building block + unit tests), explicit deferral of HTTP routes + server.ts wiring to a follow-up. The original proposal is marked `supersedes:`'d.

The other major change: locking `flag-only` policy enforcement and the rule-can-DOWNGRADE-but-not-UPGRADE config gate. This came from the Memory primitive's convergence finding (Memory is sacrosanct — never auto-fixed). The sentinel must respect that policy unconditionally.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | abbreviated (infrastructure-spec deviation) | 2 (architecture-evolved-past-proposal, flag-only-enforcement) | Rewrite to consume rules registry; lock policy gating; scope to building block |
| 2 | (converged — no material new issues) | 0 | none |

## Full Findings Catalog

**F1: Original proposal architecture predates the rules registry** — Severity: critical. Reviewer perspective: integration. Original: spec proposed `src/monitoring/parity/parityRules.ts` flat-array with sentinel-owned rules. Resolution: rewritten as thin consumer of `src/providers/parity/registry.ts`. Original proposal preserved as superseded reference.

**F2: Sentinel needs to enforce flag-only without override** — Severity: high. Reviewer perspective: adversarial / security. Original: spec was loose on whether sentinel could override a rule's policy. Resolution: locked semantics — rule policy is the authority; sentinel `remediationEnabled` config can DOWNGRADE mirror-trust to flag-only but never UPGRADE flag-only to mirror-trust. Specifically protects Memory primitive's sacrosanct status.

## Convergence verdict

Converged at iteration 2. No material findings in the final round. The spec is approved (pre-authorized per hybrid C autonomous-mode agreement). v0.1 ships the sentinel class + unit tests; HTTP routes + server.ts wiring documented as deferred follow-up.

## Deviation note

Infrastructure-spec abbreviated convergence — the sentinel is a thin consumer of already-converged rules. The load-bearing review perspectives (canonical-shape correctness, rendering, drift detection, user-edit-conflict handling, signal-vs-authority) were applied during the Skill / Hook / Memory primitives' convergence rounds. The sentinel's own decisions (cadence, concurrency, policy gating, event vocabulary) are documented in the spec's "v0.1 scope" and "Trust + safety" sections; they're load-bearing for the sentinel itself but small enough to converge in one iteration once the architectural correction (F1) landed.
