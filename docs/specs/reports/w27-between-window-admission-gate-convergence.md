# Convergence Report — W27 Between-Window Admission Gate

**Spec:** [docs/specs/w27-between-window-admission-gate.md](../w27-between-window-admission-gate.md)
**Slug:** `w27-between-window-admission-gate`
**Converged at:** 2026-08-26T07:42:00Z
**Iterations:** 3
**Final-round material findings:** 0

## Cross-model review: DEGRADED — ALL ROUNDS

Codex and Gemini reviewer families were detected as available, but every attempted
external pass degraded with `reason: error`. The standards-conformance gate was
also attempted and was unavailable with `Invalid auth token`. Convergence therefore
rests on internal reviewers plus explicit degraded-review disclosure, not on a clean
external opinion.

## ELI10 Overview

This spec describes the Window 27 admission gate that checks whether the
between-window re-ground evidence package has the required receipts before the
window treats the opening precondition as satisfied. The gate is deliberately
narrow: it checks receipt shape and whether referenced Telegram rows exist in the
chosen local store.

The review made the document more honest about what that gate proves. A pass means
the package passed structural store-presence checks. It does not prove that a quote
matches the corpus, that a hash was recomputed, that an observer assessment is
correct, or that the release is ready. Operator approval remains separate and is
not granted by this report.

The main tradeoff is intentional boundedness. The built gate catches missing or
malformed receipts and the known must-fail controls, but it does not add new
cryptographic receipt binding, route-specific rate limits, or cross-machine store
reconciliation in this release.

## Original vs Converged

- Originally, `admitted: true` could read like a broad truth or authenticity
  judgment. After review, the spec states that admission is
  structural-store-presence-only and non-authoritative for semantic truth,
  receipt authenticity, corpus reconciliation, release readiness, and approval.
- Originally, the route/input cost model was underspecified. After review, the
  spec records the actual global 12 MB JSON body limit and also names what is not
  built: no route-specific rate limiter, no package cardinality caps, no per-string
  caps, and CLI/store reads bounded only by host/runtime limits.
- Originally, multi-machine behavior was implicit. After review, the spec states
  that the HTTP route is safe only on the intended authoritative store-holder
  machine, while CLI `--store` is the explicit path for checking another store.
- Originally, evidence wording risked overclaiming Zero-Failure and Tier-3
  proof. After review, the spec says the candidate evidence does not claim a clean
  certifying full-suite run and classifies the lifecycle test as app-level HTTP
  coverage, not production-init Tier 3.
- Originally, the spec lacked convergence hygiene and lessons engagement. After
  review, it has `Frontloaded Decisions`, `Open questions: *(none)*`, P2/P5
  lessons engagement, and explicit L10 release-fragment honesty.

## Iteration Summary

| Iteration | Reviewers who flagged material issues | Material findings | Spec sections changed |
|-----------|---------------------------------------|-------------------|-----------------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware | 6 design-class findings plus precision issues | Problem statement, Proposed design, Decision points touched, Multi-machine posture, Package Contract, Binding and authenticity limits, Cost and input bounds, Lessons engaged, Evidence Basis, Frontloaded Decisions, Open questions |
| 2 | adversarial precision only | 0 design-class findings | Full-history topic wording and Required Corpus Mismatches wording |
| 3 | none | 0 | none |

## Full Findings Catalog

### Iteration 1

- Security: admission result scope was too easy to mistake for authenticity.
  Resolution: spec now states `admitted: true` is structural-store-presence-only
  and records the missing `admissionScope` field as an as-built limitation.
- Security/scalability: HTTP/package cost bounds were underspecified. Resolution:
  spec now documents the global body limit, timeout/auth posture, absent
  route-specific/cardinality/string caps, and low-QPS trusted-caller posture.
- Adversarial: full-history receipt content was not bound to the referenced
  stored row. Resolution: spec now states hashes are format checks only and the
  gate does not recompute hashes, verify quote text, compare receipt JSON against
  stored message text, verify signatures, or bind receipt JSON to rows.
- Integration: route/store behavior was machine-local without a declared posture.
  Resolution: spec now constrains HTTP use to the authoritative store-holder and
  names CLI `--store` as the intended alternate-store path.
- Decision-completeness: required `Frontloaded Decisions` and `Open questions`
  sections were absent. Resolution: both sections were added, and open questions
  reduce to `*(none)*`.
- Lessons-aware: the spec risked contradicting Zero-Failure, overstated lifecycle
  evidence, lacked P2/P5 engagement, and did not handle missing L10 release
  fragment evidence. Resolution: the spec now avoids clean-suite claims, classifies
  the lifecycle test as app-level HTTP coverage, adds P2/P5 lesson engagement, and
  states that no ordinary same-PR upgrade/next fragment was found.

### Iteration 2

- Adversarial precision: full-history topic wording still suggested explicit
  `topicId` was always required. Resolution: wording now states omitted topics
  default to `43003`, while explicit non-`43003` topics refuse.
- Adversarial precision: the corpus mismatch table could read as requiring exact
  observer label matching. Resolution: the table now names source/count constants,
  and nearby prose states observer labels are non-empty shape fields but are not
  compared to the required constants as built.

### Iteration 3

Final internal reviewers reported no remaining design-class or approval-material
precision findings. Decision-completeness reported `open-user-decisions: 0`.

## Convergence Verdict

Converged at iteration 3. The final round produced zero material findings, and
the previous round had also produced zero design-class findings after its precision
cleanup. The spec is ready for operator review and approval. Approval is not
applied by this report or by the convergence skill.
