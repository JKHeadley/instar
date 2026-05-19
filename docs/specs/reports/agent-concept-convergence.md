# Convergence Report — Agent (Layer-3 primitive)

## ELI10 Overview

An **Agent** in the Instar primitive vocabulary means a *sub-agent context* — a focused worker the main session can spawn for a delimited task (research, code review, web automation). Both Claude Code and Codex CLI have a sub-agent mechanism; they call it different things and configure it differently. This spec defines the canonical contract so an Agent definition (`name`, `description`, `allowed-tools`, `system-prompt`) renders correctly on either framework.

The major thing this spec changes for the user: nothing visible yet. v0.1 ships the contract and the framework-side docs. The actual parity rule (the code that keeps a canonical Agent definition in sync with its rendered form) is deliberately deferred to v0.2 — Codex's subagent surface needs live verification before we lock the rendering shape, and shipping a half-verified rule would be the kind of false convergence the foundational specs explicitly warn against.

## Original vs Converged

The first draft tried to ship Agent with a parity rule mirroring Skill's. The convergence pass surfaced one large issue: Codex's subagent mechanism is documented across the framework specs but has not been live-verified on the current Codex version. Shipping a parity rule against unverified rendering would either (a) be wrong-on-arrival and surface as drift the moment a real Codex subagent is created, or (b) silently no-op until someone notices.

The converged spec keeps the cross-framework contract (canonical fields, identity assertions, what-is-NOT bound) but explicitly defers the parity rule to v0.2, with the dependency (Codex subagent live research) called out in the spec's "v0.1 deferred items" section. This is an honest deferral — the work is tracked, the reason is on-record, and the contract is locked so the v0.2 rule has a stable target.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | abbreviated (pattern-instance reuse from Skill convergence) | 1 (parity rule premature) | Defer rule to v0.2, lock contract + framework docs |
| 2 | (converged — no material new issues) | 0 | none |

## Full Findings Catalog

**F1: Codex subagent surface unverified** — Severity: high. Reviewer perspective: integration. Original: spec proposed a parity rule mirroring Skill's. Resolution: rule deferred to v0.2 with explicit dependency on Codex subagent research; contract + framework specs ship now to provide a stable v0.2 target.

## Convergence verdict

Converged at iteration 2. No material findings in the final round. The spec is approved (pre-authorized per hybrid C autonomous-mode agreement) and explicitly documents the v0.2 deferral. Ready for the InstructionFile primitive + sentinel work to build on.

## Deviation note

Pattern-instance abbreviated convergence — Agent inherits its full review-cycle template from Skill convergence (the load-bearing reviewer perspectives have already shaped the canonical-source-of-truth + per-framework rendering + parity rule pattern). This is the documented `review-deviation` recorded in the spec's frontmatter.
