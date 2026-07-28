# Side-Effects Review — Wire feedback-factory processor into a scheduled job + stats route

**Version / slug:** `feedback-processor-job`
**Date:** 2026-06-16
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** Echo reviewer subagent (see Phase 5 appendix)

## Summary of the change

The feedback-factory's clustering/triage pass (`processUnprocessed`, already built + parity-tested at 100% over the recorded corpus) was invoked ONLY by tests — there was no production trigger, so reports were ingested into the canonical `JsonlFeedbackStore` but never clustered. This change wires that existing signal-producer into a real, dev-gated capability: (1) a new `FeedbackProcessingService` that owns a `JsonlFeedbackStore` at the canonical dir and exposes `stats()` (pure read) + `processNow()` (one clustering pass); (2) `GET /feedback-factory/stats` (read-only counts) and `POST /feedback-factory/process` (server-side trigger) in routes.ts, both 503 when dark; (3) a built-in `supervision: tier1` agentmd job (`feedback-factory-process.md`, cron `*/30 * * * *`) that curls the trigger and validates the pass against post-pass stats. Gated through `resolveDevAgentGate(config.feedbackFactory?.processing?.enabled, config)` — live on dev agents, dark (503 / job `enabled:false`) on the fleet. Files: `src/feedback-factory/processing/FeedbackProcessingService.ts`, `src/feedback-factory/store/JsonlFeedbackStore.ts` (added `stats()`), `src/server/routes.ts`, `src/server/AgentServer.ts`, `src/server/CapabilityIndex.ts`, `src/core/types.ts`, `src/config/ConfigDefaults.ts`, `src/scaffold/templates.ts`, `src/scaffold/templates/jobs/instar/feedback-factory-process.md`, `src/core/PostUpdateMigrator.ts`, + 3 test tiers. Driven by the approved spec `docs/specs/feedback-factory-migration.md` (Phase 1 / §191 "the processor job is actually constructed and scheduled, not dead code").

## Decision-point inventory

- `feedbackFactory.processing` dev-gate (AgentServer construction + route guards) — **add** — standard `resolveDevAgentGate` config gate; live-on-dev / dark-on-fleet. Not a content filter.
- `processUnprocessed` clustering (existing) — **pass-through** — unchanged; this change only wires it to a trigger. It remains a SIGNAL producer (similarity grouping); it never force-closes a cluster and terminal transitions stay evidence-gated (spec §252).
- `GET /feedback-factory/stats` / `POST /feedback-factory/process` — **add** — stats is read-only; process runs the existing pass. Neither gates message flow or agent behavior.

## 1. Over-block

Nothing is blocked. The stats route is a read; the process route runs an idempotent clustering pass. The only "block" surface is the dev-gate returning 503 when the feature is dark — which is correct (the capability genuinely isn't active on the fleet yet) and mirrors `/feedback-inbox/status`. No legitimate input is rejected.

## 2. Under-block

N/A — this change holds no blocking authority. The real interaction concern with the InboxDrainer is **staleness, not corruption** (an earlier draft of this artifact mis-framed it as "mitigated because both use the same append-only store" — that was WRONG: the drainer is a SEPARATE PROCESS with its OWN in-memory store instance; sharing one in-memory Map is impossible across processes). `JsonlFeedbackStore` loads `feedback.jsonl` ONLY in its constructor, and `FeedbackProcessingService` builds its store ONCE at boot — so rows the drainer appends AFTER boot would never enter the processor's in-memory Map, making every pass after the initial backlog a permanent no-op over newly-ingested reports (re-introducing the exact "ingested but never clustered" defect §191 closes; the tier-1 supervisor reads the same stale store, sees 0 unprocessed, and falsely reports healthy). **Mitigation (the actual fix): `JsonlFeedbackStore.reload()` re-folds all three JSONL files from disk, and `FeedbackProcessingService` calls `store.reload()` at the START of BOTH `stats()` and `processNow()`** so every read/pass sees what other processes appended since boot. No concurrent-write hazard: reload is a read-only re-fold and appends are atomic single-line writes (appendFileSync) — a reload racing a mid-append at worst skips one torn trailing line (already handled by the load path's torn-line skip), which the next reload picks up. `processUnprocessed` remains forward-only/idempotent (an item already flipped to `processing` is never re-picked). A regression test (`tests/unit/feedback-factory/processing-service.test.ts`) reproduces the production ordering — service constructed FIRST, then a NEW row appended by a SEPARATE store instance pointed at the same dir — and asserts the next pass clusters it; it fails without the reload and passes with it.

## 3. Level-of-abstraction fit

Correct per the approved spec §162/§251: receiver/dispatch are HTTP at the edge (Vercel), the heavy/bursty processor runs at the JOB layer on a capable machine (here echo), curated state is data. The processor runs server-side via the trigger route (single authority over the canonical store) rather than a duplicate store in a CLI process — matching the established agentmd-job pattern (correction-analyzer, release-readiness-check). No layer inversion.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). The processor is a DETECTOR/signal producer: similarity/Jaccard grouping emits grouping signals. It holds NO terminal authority — it never force-closes a cluster; terminal lifecycle transitions remain evidence-gated by the existing API hard gate (scar a, spec §252). The new dev-gate is a config enable/disable, not a brittle content blocker with its own block path. No new brittle authority is introduced.

## 5. Interactions

- Shares the canonical store dir with the InboxDrainer (ingest writer), which is a **SEPARATE PROCESS** (the launchd `feedback-inbox-drain.mjs` job) holding its OWN `JsonlFeedbackStore` instance. There is no shared in-memory state and there cannot be (different processes). Coordination is purely on-disk via the append-only last-write-wins JSONL format (each mutation appends a full row; torn lines skipped on load): no double-write corruption. The cross-process **staleness** risk (the processor's boot-time in-memory snapshot never seeing post-boot ingest) is closed by the reload-per-pass fix in §2 — `FeedbackProcessingService` re-folds from disk at the start of every `stats()` and `processNow()`, so it always observes the drainer's appended rows.
- `applyDefaults` backfills `feedbackFactory.processing` for existing agents; `migrateBuiltinJobs` installs the job (ships `enabled:false`); `migrateClaudeMd` adds the awareness section. No shadowing of an existing check; no double-fire (single cron schedule, server-side single-flight by virtue of the route).
- Does not touch outbound/inbound messaging, session lifecycle, or any sentinel/watchdog.

## 6. External surfaces

Two new authenticated routes (503 when dark) and one new built-in job (off by default on the fleet). No change visible to other agents/users/systems while dark. On a dev agent the job runs every 30 min and appends to local `clusters.jsonl` + flips local feedback items `unprocessed→processing` — no network egress, no external API, no messages, no GitHub. The processing pass's only effect is local JSONL appends (re-verified: zero external side effects). Timing dependence is limited to the cron cadence; no conversation-state dependence.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The canonical `JsonlFeedbackStore` lives on the machine running the feedback-factory processor (per spec §162, the heavy processor runs on ONE capable machine, NOT replicated — the operated instance owns its store). The stats route reports THAT machine's store; the job runs on the machine where it's scheduled. This is the spec's intended single-canonical-store posture (split-brain prevention, §253 "ONE shared canonical DB"). No silent single-machine assumption defect — it is the deliberate, spec-mandated design. No user-facing notice surface (so no one-voice concern); no generated URLs; durable state (the JSONL store) is machine-owned and does not transfer on topic move.

## 8. Rollback cost

Cheap and safe. PR-revertible. Dark on fleet → flag-off is byte-identical to today (route 503s, job `enabled:false`). If wrong on a dev agent: set `feedbackFactory.processing.enabled:false` (no restart needed for the route gate read; job disable via the manifest). The processing pass only appends to `clusters.jsonl` and flips item status forward — no destructive mutation, no data loss, fully forward-only. Worst case: delete the derived `clusters.jsonl` and the source `feedback.jsonl` is untouched (items just revert to being re-clusterable since status flips are additive rows).

## Phase 5 — Second-pass review appendix

**Concern raised** (independent reviewer): the long-lived `FeedbackProcessingService` constructed its `JsonlFeedbackStore` once at boot and never reloaded, while the InboxDrainer (a SEPARATE process) appends rows continuously after boot — so after the initial backlog the 30-min job would be a permanent no-op over newly-ingested reports, reintroducing the exact §191 "ingested but never clustered" defect, with the tier-1 supervisor masking it (same stale store → 0 unprocessed → false healthy).

**Resolution** (iterated before commit, per Phase 5): added `JsonlFeedbackStore.reload()` (re-folds all three JSONL files from disk using the same load path as the constructor) and call it at the START of both `stats()` and `processNow()` in `FeedbackProcessingService`. Added a regression test reproducing the live production ordering (service constructed FIRST, a NEW row then appended by a SEPARATE store instance on the same dir) — independently verified to FAIL without the reload and PASS with it. tsc clean; 14 unit + 5 integration + 6 e2e green. Artifact §2/§5 corrected (the original "same append-only store mitigates it" framing was wrong — the risk was staleness across separate-process in-memory instances, not corruption).

**Verdict after resolution:** concern resolved; the design now reads fresh canonical state every pass. Re-grounded against the code by the driving agent (Echo), not just asserted.

**Independent reviewer re-confirmation:** "Concern resolved — concur." Verified: `reload()` re-folds all durable state via the same constructor load path and assigns fresh Maps wholesale (no stale leak / compacted rows don't linger); `reload()` precedes every read in both `stats()` and `processNow()`; exactly one reload per pass (no intra-pass double-processing); the regression test authentically models separate-process-append-after-boot and fails if the reload is removed from either surface. Non-blocking note (performance, not correctness): the reload re-parses the full JSONL per call — acceptable at the 30-min cadence + low stats-call rate; cost scales with total durable rows. If the canonical store grows very large, a future optimization could track a byte offset (like TokenLedgerPoller) instead of full re-fold. <!-- tracked: topic-12476 -->
