# Side-Effects Review — Per-Topic Reap Notification + Mid-Work Resume Queue

**Version / slug:** `reap-notify-resume-queue`
**Date:** `2026-06-12`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `[pending — required: session lifecycle + sentinel surface]`

> STATUS: IN-FLIGHT — this artifact accompanies the per-step commits of the
> build and is completed (all seven questions answered, second-pass appended)
> before the PR opens. Driven by the converged + approved spec
> `docs/specs/reap-notify-per-topic-and-midwork-resume-queue.md` (r7).

## Summary of the change

Implements the reap-notify + resume-queue spec: Part A makes every non-silent
session reap produce a durable per-topic notice (PendingRelayStore rows with a
`reap-notify:` PK prefix, drained by a new always-on ReapNoticeDrain; the
store's restore-purge gains the R1.6 held-row exemption + 7-day corruption
clamp), and Part B tags mid-work reaps with killer-supplied evidence at the
terminateSession chokepoint and revives them in order via a durable
ResumeQueue + gated ResumeQueueDrainer (observe-only Tier 1 LLM check during
soak). Files: src/messaging/{pending-relay-store,reap-notice-delivery-id}.ts,
src/monitoring/{delivery-failure-sentinel,ReapNotifier,ReapNoticeDrain,ReapLog,
ResumeQueue,ResumeQueueDrainer,PressureGauge,SessionMigrator,SessionReaper}.ts,
src/core/SessionManager.ts, server wiring + routes, ConfigDefaults,
PostUpdateMigrator, templates, three test tiers.

## Decision-point inventory

- `PendingRelayStore.purgeStaleClaimable` — modify — restore-purge staleness predicate (R1.6); brittle by design (transport-layer mechanics, not judgment).
- `PendingRelayStore claim queries (selectClaimable / selectClaimableReapNotices / claimCas)` — modify/add — origin-scoped single-owner contract between two drains; transport-layer mechanics.
- `ReapNotifier flush` — modify — per-topic grouping + release-tier selection (IMMEDIATE vs SUMMARY vs quiet-hours); deterministic template authoring, no judgment blocking.
- `ReapNoticeDrain` — add — tier0 deterministic delivery state machine (claim → send → backoff → terminal escalation).
- `terminateSession evidence clamp` — modify — enum whitelist on killer-supplied evidence (hard-invariant validation, brittle-blocker exemption).
- `ResumeQueue eligibility classifier` — add — deterministic eligibility rules (strong/weak evidence, job opt-in).
- `ResumeQueueDrainer gates` — add — deterministic spawn-eligibility checks delegating to EXISTING authorities (PressureGauge, QuotaManager.canSpawnSession, session cap, migration-in-flight); plus observe-only Tier 1 LLM check.
- `Dequeue hard invariants` — add — UUID/enum/charset/length clamps protecting `claude --resume` argv (brittle-blocker exemption).
- `Emergency-stop → queue pause` — add — pass-through consumer of the existing MessageSentinel/stop-all authority.

---

## 1. Over-block

[IN-FLIGHT — completed at Phase 4 after build.]

## 2. Under-block

[IN-FLIGHT — completed at Phase 4 after build.]

## 3. Level-of-abstraction fit

[IN-FLIGHT — completed at Phase 4 after build.]

## 4. Signal vs authority compliance

[IN-FLIGHT — completed at Phase 4 after build. Phase 1 written check recorded
in build plan: no new brittle judgment blockers; drainer gates delegate to
existing authorities; Tier 1 check observe-only; hard invariants under the
documented exemption.]

## 5. Interactions

[IN-FLIGHT — completed at Phase 4 after build.]

## 6. External surfaces

[IN-FLIGHT — completed at Phase 4 after build.]

## 7. Rollback cost

[IN-FLIGHT — completed at Phase 4 after build. Levers: reapNotify.perTopic=false,
reapNotify.drainEnabled=false, resumeQueue.enabled=false / dryRun=true; no DDL.]

## Build progress notes (per-step, folded into the final review)

- Step 1 (relay-store foundation): R1.6 purge fix + origin scoping + CAS claim; DFS spec §3h updated.
- Step 2 (ReapLog): notify record pairs + midWork/workEvidence through the normalizer; fixed pre-existing launchLane drop-on-read (Rule-1 deviation, noted for SUMMARY).
- Step 3 (evidence chokepoint): WorkEvidence vocabulary module + terminateSession opts.workEvidence with enum clamp + ReapGuard.workEvidence() observe-only fallback (closure-error → nothing; critical-tier marker) + midWork stamped on event/reap-log/session record.
- Step 4 (killer stamps): SessionMigrator pre-grace evidence snapshot + halt-refusal recording (refusals ≠ halted, no double-respawn); SessionReaper asserts authoritative-empty evidence on proven-idle reaps; chokepoint fallback excludes active-process under bypassActiveProcessKeep.
- Step 5 (ReapNotifier v2): per-topic grouping with separate affected-set (cap 500 + overflow), plain-English reason map, IMMEDIATE/SUMMARY release tiers with quiet-hours holds + per-flush cap, durable enqueue with outcome records, loud enqueue-failure fallback, legacy modes preserved (perTopic:false byte-compatible; drainEnabled:false direct-send).
