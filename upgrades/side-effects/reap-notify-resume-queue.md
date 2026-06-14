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
- Step 6 (ReapNoticeDrain): always-on 30s drain over the reap-notify lane (CAS claim, lease + prior-boot reclaim, per-pass cap 15, backoff to maxAttempts 8, terminal escalation into ONE stable-id attention item, bounded terminal-row cleanup [Rule-2 deviation: added because DFS's retention pass is default-OFF, so the always-on lane needed its own growth bound]); boot wiring with lazy telegram refs; NotificationBatcher gains quietHoursEndAt/nextSummaryReleaseAt (one quiet-hours clock).
- Step 7 (PressureGauge): the spec's "shared PressureGauge extraction" already exists as HostPressureSampler (one shared definition delegating to SessionReaper.computePressure, parity-tested in host-pressure-sampler.test.ts) — plan deviation Rule 4: reused instead of duplicating. Wired sessionManager.setPressureTierProvider to it with the reaper's configured thresholds.
- Step 8 (ResumeQueue): durable JSON queue (fsync discipline temp→rename→dir), single-writer lockfile (same-host stale reclaim; foreign-host NEVER probed — loud disable with documented recovery), R2.2 eligibility classifier, stable-key dedupe, resurrection ledger with 24h window + requeue-as-the-one-override, incident-age TTL with pause-freeze + pressure-starved marker, overflow drop-to-aggregate, corrupt-file sidecar, boot reconciliation (starting→failed-attempt + reap-log re-enqueue seam). Dry-run interpretation recorded: entries ARE durably enqueued (soak observable); only spawning + user-facing claims are gated.

- Step 9 (ResumeQueueDrainer + spawn cwd): gated one-per-tick drainer (calm-ticks on the shared gauge, quota/cap/migration gates never bypassable, manual drain skips calm-ticks ONLY), 7 reality validations + hard invariants (fail-safe on dep errors), failure ladder + breaker + aggregated give-ups, Tier1 observe-only with 5s deadline + off-lever, dry-run inertness (would-resume once per entry, no attention), R2.11 honest notice + literal-data continuation prompt; spawnInteractiveSession + spawnSessionForTopic gain the explicit per-spawn cwd (L13 named extension).
- Step 10 (boot wiring + emergency stop + routes): queue+drainer constructed at boot (lock-disable logged, lazy telegram refs, 30s-deferred reap-log boot reconciliation — topic-bound candidates only; job entries rely on cron recurrence since opt-in is not reconstructible from the reap-log); enqueue hook at the sessionReaped listener; emergency-stop wiring (stop-all → pause; per-topic stop + MessageSentinel stop → cancelByTopic + operator-stop record); R2.10 routes with clamps; QuotaManager.isMigrationInFlight added (canSpawnSession permits mid-migration spawns absent pressure — the drainer needs the stricter probe); Session.cwd recorded at spawn; JobDefinition.resumeOnReap; Tier1 check wired via shared LlmQueue with attribution.
- Step 11 (config + migration parity): ConfigDefaults gains reapNotify.perTopic + maxImmediatePerFlush ONLY (drainEnabled + resumeQueue.* deliberately code-defaulted for the fleet flip — registration-discipline test pins this); resumeQueue classified in DARK_GATE_EXCLUSIONS (cost-bearing); resume-queue state files registered machine-local in the state-coherence registry; generateClaudeMd Reap-Log section updated + NEW content-sniffed migrateClaudeMd section + framework-shadow marker; release fragment with maturity-tagged announcements (Part A stable, Part B preview/watch-mode).
- Step 12 (test tier): integration lifecycle (reap → durable notify pair, quota-shed end-to-end, P17/P19 burst invariants incl. K-entries-vs-rejecting-spawn-target) + R2.10 routes/emergency-stop integration + Tier-3 feature-alive E2E on the production init path (real AgentServer + ReapLog + PendingRelayStore + ReapNotifier + ReapNoticeDrain + ResumeQueue + ResumeQueueDrainer; cwd round-trip through the L13 spawn-path parameter; wiring integrity for pressure gauge / spawn gate / relay store / LlmQueue tier-1).
- Step 13 (full-suite triage): ratchet/parity updates for the new code (dark-gate golden map +10 shift re-verified by hand; ResumeQueueDrainer registered in componentCategories; migrator CLAUDE.md section tracked in feature-delivery-completeness; session-reaper exact-match assertions gain workEvidence). Behavior-relevant: THREE lenient-side catches REMOVED so a throwing dep resolves to the drainer's strict side per R2.6 — QuotaManager.isMigrationInFlight no longer swallows probe errors (sole caller is the drainer gate, which blocks on throw), and the server's migrationInFlight/topicOwnerElsewhere dep wrappers no longer catch (drainer gate/validateReality resolve to blocked/invalidated). Every remaining new catch carries an in-brace @silent-fallback-ok justification; no-silent-fallbacks baseline untouched (net −1 vs main). localhost-link-guard-route test made hermetic (own tmp stateDir — '/tmp' shared outbound-dedup.db across runs and suppressed sends).
