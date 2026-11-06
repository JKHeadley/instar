# Side-Effects Review — Keep historical delivery reconciliation quiet

**Slug:** delivery-notice-scan-quiet
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** delivery_notice_review (independent Codex agent)

## Summary of the change
Tier 1, small reversible fix for fb-f348f8e4-15f. Runtime tags delivery evidence as live or scan. The server delegates its existing reporting callback to SessionDeliveryReporter; scans use explicit record-only TelegramAdapter Attention admission, and never initiate a notice send. Accepted originals close records accurately. Tests characterize PR2819 first, reproduce 151 attempted notices across 48 topics, and verify the corrected behavior through durable adapter persistence and runtime wiring. No new activity heuristic, public route, or durable schema. Size and final validation totals are recorded in the PR; one independent review round, initial gate attempts recorded in the build summary.

## Decision-point inventory
- Runtime delivery reporting: producer source custody added at both live onHold and historical scan callsites.
- Attention admission: explicit record-only operation persists before returning, ahead of every hub/topic route and selectivity rollout choice.
- Reporter: historical observations update records; only live observations initiate the existing notice path. Accepted original receipts close their condition without treating quiet receipts as delivered explanations.
- Existing selectivity, tone policy, transport identity/dedup, recovery scheduling, and serving-lease authority pass through unchanged.

## 1. Over-block
The scan no longer sends late-recovery explanations into active topics either. This is intentional: a historical record is not authority to start a new conversational turn. Timely live failures retain their existing notice path; original replies and recovery are untouched. No conversational reply is rejected. Records remain in Attention.

## 2. Under-block
Live delivery failures can still produce their existing notices under disabled/observing selectivity. This preserves the live failure path rather than changing fleet rollout. They are distinct from the historical scan responsible for this incident. The scan cannot invoke hub or topic transport even if category push is enabled, because record-only admission returns first.

## 3. Level-of-abstraction fit
Producer custody belongs at the runtime boundary. One reporter owns reconciliation semantics; adapter admission owns durable state and the no-network return. The scan keeps its bounded pagination, cadence, and all delivery evidence. No filter is inserted into reply transport.

## 4. Signal vs authority compliance
Complies with docs/signal-vs-authority.md. Source is explicit structural producer provenance, not a content, timestamp, or topic-liveness judgment. The operation declares record-only intent. Existing notification and tone authorities retain message judgment. No new brittle blocker or competing activity authority is added.

## 5. Interactions
The source is mandatory in the callback type and set at both producers. Immediate failures remain live; scan replay and restarts remain scan. Attention admission retains the shared condition identity, acknowledgment and reopen logic. Recovered replies retain their existing acceptance logging; the scanner now closes even late accepted records with a truthful receipt resolution. There is no fabricated delivery id and no new network retry. Reconciliation may race with a new observation as before; no original send state is mutated by this reporter.

## 6. External surfaces
Quiet topics and the Attention hub receive no historical scan notices. Attention records remain readable and refresh with the latest delivery state. Live notices retain the origin automation pipeline and stable logical send id. No config or protocol migration, no new operator action.

## 7. Multi-machine posture
Machine-local BY DESIGN: each origin outbox retains its local sealed delivery custody and reconciles its matching durable Attention record. Existing pool reads expose the records; no new state is introduced or stranded. The scan's record-only behavior runs on every machine independent of serving lease and rollout state, so multiple scanners cannot emit multiple voices. Live origin sends still use existing serving-lease and logical identity controls.

## 8. Rollback cost
Revert this code and release. No migration, state repair, or preference reset is necessary. Old Attention records remain compatible. Previously sent Telegram notices are not deleted.

## Validation
Before the fix, the extracted production callback attempted all 151 topic notices in the burst test; the late-accepted test also caught the inaccurate delivered-explanation resolution. Corrected tests cover burst, restart, failed-state refresh, accepted closure, live send identity and live HTTP failure persistence. PR2819 characterization ran before source edits and passed all three rollout settings. Final focused test results and full merge-floor evidence are recorded in the PR.

## Second-pass review
**Reviewer:** delivery_notice_review

Concur with the review. Independently inspected the final runtime source tagging, server wiring, reporter, adapter admission and condition closure, and the unit, integration and runtime lifecycle regressions. Scan provenance is assigned at the producer and cannot be overridden by stored row fields. Record-only admission returns before every hub/topic route, independent of selectivity settings; acceptance reconciliation uses the existing local audited close operation, including when automatic sweeps are disabled. The corrected closure preserves sticky/security refusal and cannot invoke legacy status-message or forum-topic transport. Live failures retain the existing origin automation identity and notice path; original reply delivery, recovery and scan pagination are unchanged. The initial concern about silent status updates initiating legacy transport was corrected and covered with both lifecycle settings. No unresolved correctness or signal-versus-authority concern identified in the reviewed source.

## Class-Closure Declaration

**Defect class:** unbounded-self-action. **Closure:** n/a.
The remaining notice send is the existing one-shot live failure callback for an original conversational send. The historical self-triggered scan now performs strictly record-only reconciliation with zero notify actions, including repeated scans and restart. No controller, retry, spawn, or recovery loop is added. The burst/restart regression and real runtime lifecycle test cover this distinction.

## Proportion and verified evidence
Four runtime files, 108 runtime lines changed; targeted results: 92 unit tests passed (one existing skip), 10 integration tests passed, and 28 runtime lifecycle tests passed. All 52 lint checks pass. One independent design/final review, with one acceptance-path correction. The first two commit attempts stopped on missing class-closure metadata and its human-readable mirror; source tests stayed green. Full native/CI merge evidence will be checked before merging.
