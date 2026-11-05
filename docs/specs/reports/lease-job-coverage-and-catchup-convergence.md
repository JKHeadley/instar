# Convergence Report — Lease job coverage and explicit catch-up

## ⚠ Cross-model review: DEGRADED — ALL ROUNDS (degraded-all-rounds)

The installed Codex external reviewer was invoked on every changed review body but timed out. No completed external opinion is claimed. Internal security, scalability, integration, adversarial, decision-completeness and lessons-aware review converged, and the live standards checker ran each round.

## ELI10 Overview

A computer that takes over an agent's lease can have a different list of scheduled jobs. The new holder will keep dated, signed, metadata-only observations of what other registered computers reported. When a lease moves, it will compare that evidence with its own jobs and tell the operator which ones are missing, disabled, pinned to another machine, or missing a declared dependency. Old or unavailable evidence will be marked uncertain, never healthy.

A lease takeover will also stop automatic replay of overdue jobs unless that job explicitly asks for one catch-up run. The safe default is to ask the operator. The lease and a durable local admission record limit automatic requests, and a move back to another machine without shared proof returns to ask. This work does not enable git-sync or copy token-bearing config.

## Original vs Converged

The first draft fetched the existing full `/jobs` response, filtered it after receipt, treated scheduler-less empty replies as catalogs, and used a local timestamp as a catch-up identity. Review replaced that with a metadata-only signed endpoint, direct nonce challenge per recipient, explicit incomplete and stale states, a verified promotion identity, and an ask fallback across lease flaps. It added bounded polling, safe add-only built-in reconciliation, and explicit operator-visible failure states. The signed response cannot be replayed through another recipient to reset freshness.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
| --- | --- | ---: | ---: | --- |
| 1 | Security, scalability, integration, lessons | 15 | 3 | Metadata-only transport, signed peer identity, offline coverage, safe repair, catch-up admission |
| 2 | Lessons, integration | 6 | 1 | Concrete Ed25519 nonce envelope, bounded holder-local catch-up, Tier 0 supervision |
| 3 | Security, integration, lessons | 2 | 0 | Removed nonce-bound relay and hardware-only SelfHealGate coupling |
| 4 | None | 0 | 0 | Converged |

Standards-Conformance Gate: ran in rounds 1–4; round 2 checked 95 standards and flagged possible multi-machine completeness and reminder cadence concerns. The source-definition replication is the separately sequenced follow-up. Reminder cadence remains bounded and tied to an unresolved mismatch. External Codex review: degraded by timeout on every changed body.

## Proportion

Tier 2+ feature; four rounds of a six-round cap. This is a multi-machine and execution-admission change, so the review was proportionate.

## Left behind

- The 500-job cap is a conservative resource bound; capacity should be remeasured after rollout. Over-cap observations are labeled incomplete.
- A stale catalog may describe a deliberately retired job. The alert presents provenance and uncertainty; operator resolution is required.
- Full source job replication and dependency transfer are a separately sequenced build task, not treated as solved by metadata observations.
- External review completed no opinion because the CLI timed out; this is a disclosed assurance gap.

## Full Findings Catalog

- Security: existing `/jobs` serializes execution text and gates; resolved with a serving-side metadata projection and validation before persistence.
- Security and integration: shared bearer does not authenticate a machine identity; resolved with nonce-bound Ed25519 signatures verified against the registry key.
- Security: relaying nonce-bound evidence could refresh stale data; resolved by direct polling from each recipient and preserving receipt time.
- Scalability: unbounded peer polling and ambiguous empty catalogs could erase evidence; resolved with bounded transport, explicit catalog completeness and durable last-good observations.
- Integration: scheduler-less standby must still expose its installed jobs, and role-follow restart must cover all scheduler-enabled lease changes; explicit prerequisites added, with separate takeover fix.
- Integration: missing legacy defaults and git-sync auto-enable are unsafe; separate add-only migration preserves local settings and forces git-sync disabled.
- Adversarial: a promotion timestamp and transient job claim do not give exactly-once semantics across crashes or lease flaps; resolved with a durable local request record and conservative ask fallback across machines or uncertainty.
- Lessons: unqualified machine-local state, wrong supervision tier, first-detection alert and hardware-only SelfHealGate use were revised to signed replicated observations, Tier 0 bounded polling, safe reconciliation before notice, and direct breaker primitives.
- Decision-completeness: catch-up default, trust boundary, retention, repair and public view were frontloaded.

## Convergence verdict

Converged at round 4. The final internal round found no material design issue. External review remained degraded by timeout; implementation must test the contracts directly.
