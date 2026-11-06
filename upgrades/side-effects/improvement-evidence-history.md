# Side-Effects Review — improvement evidence history

**Version / slug:** `improvement-evidence-history`
**Date:** 2026-11-05
**Author:** Echo
**Second-pass reviewer:** independent build reviewer `review_history`

## Summary of the change

Strengthen foundational Observability in the paired constitutional books. Extend BlockerLifecycleService's existing summary/trend reads with latest feature counts, exact evaluation times, rule versions, explicit evidence gaps and bounded-history disclosure. Preserve those optional fields through the existing pool sanitizer, accepting older peers. No database, registry, timer, evaluator or promotion authority is added. Base: fresh origin/main 154a09ffd, package 1.3.1682, JKHeadley/instar; isolated clone used because the worktree helper rejected this agent's nonstandard home. Agent identity was set before coding.

## Decision-point inventory

No product block/allow decision changes. Existing peer schema validation is extended to reject malformed optional read fields, reporting that peer as unavailable rather than inventing clean data. Existing session, promotion and ordinary service authorities are untouched.

## 1. Over-block

No ordinary-service block/allow surface. Old peers without the extension remain compatible. A new peer sending contradictory omission counts or malformed timestamps is excluded from the combined read and its failure remains visible.

## 2. Under-block

This read slice does not prove universal feature coverage, a baseline contract, sample sufficiency or uninterrupted cadence. Series compatibility compares the recorded contract/rung and evidence statuses; cadenceContinuity is explicitly unknown. Missing writes cannot be reconstructed from snapshots. The constitutional universal-coverage gap stays named.

## 3. Level-of-abstraction fit

The existing ledger owns durable evaluations, the existing service projects them, and the existing route validates peer projections. No parallel owner. The separate operator-authorized job extension uses the existing maturation review and cadence.

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md. Informational read arithmetic only; no brittle blocking authority. A schema-invalid peer cannot contribute asserted evidence but ordinary services keep serving.

## 4b. Judgment-point check

No competing-signals judgment is replaced with static logic. Optional schema and byte accounting are structural facts. The standards' intelligibility and meaningful-improvement duties still require recorded judgment, not a passing shape check.

## 5. Interactions

Historical byStatus remains backward compatible; additive latestByStatus uses current feature rows. Exact timestamps preserve multiple checks in one day. Contract or rung changes and insufficient/missed evidence do not assert series continuity. The raw 90-day ledger is unchanged. Projection budget is 384 KiB UTF8, reserving 128 KiB below the existing 512 KiB peer response ceiling for factor histories and envelope. Newest-first round-robin allocation avoids spending all space on the alphabetically first feature; only contiguous suffixes remain. Per-feature omissions and omitted feature counts disclose bounds. Real pre-change 7-day/90-day responses were 276808/382179 bytes across 180 features; new fields without a budget would exceed the peer limit.

## 6. External surfaces

Additive fields in existing /blocker-lifecycle summary and trend envelopes, including pool reads. No raw conversational content or credentials are added. Constitutional amendment is paired with Rule 39 in instar-2; final-head code-owner review and counterpart declaration remain required before merge.

## 6b. Operator-surface quality

No new user action. Existing consumers can inspect honest timestamps/counts/gaps. This patch does not claim a new deployed chart or an at-a-glance human validation; those remain part of the authorized run.

## 7. Multi-machine posture

Proxied-on-read through the existing /blocker-lifecycle?scope=pool envelope. Each origin retains its identity; no cross-origin grades are merged. Old peers are accepted without claiming new metadata. No new state or generated user URL. No notifications added by runtime code.

## 8. Rollback cost

Code revert restores the old projection. No data migration or repair; all history stays with the same ledger. The separately saved job body has a recorded before-image and manifest-version concurrency check.

## Independent review

Initial review found peer projection stripped new metadata and structural compatibility could overclaim cadence continuity. Both repaired. Live payload sizing then exposed the existing peer byte ceiling; projection is now explicitly bounded rather than increasing that ceiling. Review of paired wording found and repaired loss of the original universal per-feature metrics duty in Rule 39. Final allocation review concurred: the full empty envelope is counted, per-point comma cost is conservative, omission digits can only shrink, and false-to-true series flags shrink. Independent review also confirmed the restored universal metrics duty matches both books. Focused unit checks: 16 passing. Pool integration checks: 13 passing, including older peers, exact times, invalid metadata, and byte-budget validation.

## simplestRobustRoute

Use the existing ledger, summary/trend service and pooled read; extend the existing recurring review with scoped instructions. No added background machinery. Start: real persisted evaluation; end: truthful local and peer projection; limit: original ledger retention and explicit read budgets. This is a read-path proof, not an unattended improvement-outcome claim.

## 2026-11-06 Building audit supplement

The only additional change is the content-bound Building-family audit record required by the constitutional edit. Independent same-family Codex review accepted exact candidate digest545426ef273d92449be8cc2189adfb077959bd17a3221ae75e16e0e190d640ff,43unchanged article identities and substantive alignment with pairedRule39. Floor34/40 is preserved with no rebaseline. Actual recorder reports audit-current=true. Protected-base/reference resolution did not certify a fresh enforcement ratio; the report explicitly states that limit. The separate direction approval remains unsatisfied: this audit is not operator ratification. No runtime, control, notification, migration or rollback-cost change. Existing over/under-block, multi-machine and operator-surface assessments remain applicable. Revert restores the old audit fact and its truthful stale state; it cannot authorize a constitutional merge.
