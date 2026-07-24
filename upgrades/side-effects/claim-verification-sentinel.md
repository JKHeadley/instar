# Side-Effects Review — Claim Verification v1 dark observer

**Version / slug:** `claim-verification-sentinel`
**Date:** `2026-07-20`
**Author:** `Instar-codey`
**Second-pass reviewer:** `throughput_floor_build (independent final-delta concurrence after full review remediation)`

## Summary of the change

This change extends the existing Completion Claim verifier into the converged v1 Claim Verification dark observer. It modifies the Stop hook, extraction arbiter, verifier queue, server routes/config, canonical metadata-only storage, backup/file-viewer exclusions, and informational dashboard copy. It adds factual extraction and assessment decision points but preserves the existing Action-Claim router as the only outbound authority.

## Decision-point inventory

- `ClaimClauseArbiter.arbitrate` — modify — one bounded Claude call returns backward-compatible legacy labels plus the strict general-claim envelope.
- `parseGeneralClaimEnvelope` — add — deterministic schema, span, operand, selector, duplicate, and consequence invariants decide whether model output is admissible evidence.
- `applyClaimCriticalityFloor` — add — deterministic minimum severity; model suggestions can only raise it.
- `assessClaim` — add — exact supported adapters decide supported/refuted/unverifiable from structural evidence or fresh snapshots.
- `CompletionClaimVerifier.enqueue` — modify — bounded cost, fairness, idempotency, concurrency, and expiry admission for observe-only work.
- `routeActionClaim` — pass-through — remains the sole outbound-message authority and consumes only the legacy arbitration projection.

## 1. Over-block

No block/allow surface — Claim Verification never blocks, delays, rewrites, retries, or sends an outbound message. Queue or provider refusal drops only an observation and records the denominator honestly.

## 2. Under-block

The observer intentionally misses claims when the provider is unavailable, content exceeds the privacy boundary, the strict envelope is invalid, the queue/cost budget is exhausted, or a non-Claude framework resolves the general lane. Capacity and pull-request assertions remain `unverifiable:no-canonical-oracle`; v1 does not pretend that local configuration or prose is authoritative. Protected-cue coverage detects some extraction misses but does not prove saturation.

## 3. Level-of-abstraction fit

This is a signal producer at the right layer. A model handles contextual extraction; deterministic code enforces schema and safety floors; exact adapters assess only canonical structural evidence. The result feeds local audit/corpus projections and does not run parallel to the existing outbound Action-Claim authority.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The observer's `disposition` is structurally fixed to `unchanged` and corpus rows are `automationEligible: false`. General assessments are never passed into `registerUnifiedFutureClaims`; only the established legacy projection is.

## 4b. Judgment-point check (Judgment Within Floors standard)

Extraction is a judgment point handled by the Claude arbiter. Criticality and schema checks are enumerable invariants: irreversible premises and protected predicates have deterministic floors, and invalid shapes are not competing-signal judgments. Verifier adapters compare exact evidence within the uncertainty floor; unsupported subjects remain unverifiable.

## 5. Interactions

- **Shadowing:** all nonempty Stop responses may enter observation, but the hook remains fire-and-forget and the server response cannot shadow message delivery.
- **Double-fire:** UUIDv7 attempt identity and content fingerprinting return the prior admission outcome for an exact retry; a collision with different content is refused.
- **Races:** work is globally bounded, one-at-a-time per topic, round-robin across topics, and expires after 120 seconds. Audit rotation and corpus bounds are machine-local synchronous writes; failures drop observation only.
- **Feedback loops:** corpus and pool projections are explicitly automation-ineligible. No v1 miner, calibration, promotion, or policy-writing lane exists.
- **Legacy behavior:** the same arbiter call supplies the old Completion Claim projection, and Action-Claim routing reads only that projection.

## 6. External surfaces

The Stop hook sends a new bounded structural envelope to the local server. Persistent state is written beneath the dedicated claim-verification directory, excluded from backup and denied by file-serving routes. Pool reads expose only thresholded aggregates, cap peers and bytes, use short per-peer deadlines, and report omissions/failures. There are no new operator-facing actions, external sends, URLs, approvals, or destructive controls.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. This is an informational observation surface with no action; the heading immediately states what the counts represent.
2. **Zero raw internals as primary content?** Yes. Dashboard copy uses plain-language observation and coverage terms; no UUIDs, hashes, raw claims, or corpus rows are displayed.
3. **Destructive actions de-emphasized?** Yes. No destructive action exists on the surface.
4. **Plain language + phone width?** Yes. Only existing responsive text blocks were relabeled; no tables, controls, fixed widths, or horizontal layouts were added.

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read** — canonical audit and corpus state remain machine-local because observations describe that machine's admitted work. `GET /completion-claim/audit?scope=pool` merges only privacy-qualified aggregates from up to sixteen peers and explicitly reports partial coverage. It emits no user-facing notices, holds no topic-transfer authority, and generates no URLs. Topic pseudonyms are local grouping aids and never exposed as aggregate dimensions.

## 8. Rollback cost

Disable Claim Verification and restart to stop new observations, or revert and ship a patch. Existing files are inert metadata-only logs excluded from backup and file serving; no migration or agent-state repair is required. The bounded housekeeper can remove only the exact legacy audit filenames after the grace period and writes receipts.

## Conclusion

The review keeps v1 deliberately narrow: dark observation, a dedicated fair ingress queue over the shared metered LLM queue, scrubbed corpus logging, exact uncertainty, bounded retention, and signed privacy-qualified pool pages. Independent review findings closed the hostile-evidence, invalid-envelope, shared-metering, retention, pagination, and outcome-integrity gaps. It contains no v2 miner/subagent work and no v3 calibration, surfacing, or authority promotion.

## Second-pass review (if required)

**Reviewer:** `throughput_floor_build`, following the original `claim_v1_independent_review`
**Independent read of the artifact: concur**

The original review iterated through every blocking contract. The final reviewer independently confirmed that ordinary observations cannot settle each other, only an explicit later authoritative receipt matching the original claim ID, predicate, and exact source revision can create T0, wrong revisions refuse, and settlement remains automation-ineligible with unchanged disposition.

Post-review CI hardening classified every intentional fail-safe in the new parsers and bounded stores, refreshed the hand-audited dark-gate line map after the six-line config insertion, removed a malformed pre-release guide in favor of the canonical `upgrades/next` fragment, and fixed the test cleanup import. These changes alter no runtime authority or reviewed settlement contract.

## Evidence pointers

- `tests/unit/claim-observation-v1.test.ts`
- `tests/unit/turn-evidence-completion-verifier.test.ts`
- `tests/unit/PostUpdateMigrator-completionClaimHook.test.ts`
- `tests/unit/backup-manager.test.ts`
- `tests/unit/fileRoutes-never-served.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered action controller is added — not applicable. The periodic housekeeper is retention-only and cannot restart, swap, respawn, spawn, notify, retry, re-drive, kill, or affect delivery.
