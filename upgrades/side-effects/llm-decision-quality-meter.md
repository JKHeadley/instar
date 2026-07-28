# Side-Effects Review — LLM-Decision Quality Meter (uniform provenance + outcome grading)

**Version / slug:** `llm-decision-quality-meter`
**Date:** `2026-07-12`
**Author:** `echo`
**Second-pass reviewer:** `echo (dedicated reviewer subagent) — high-risk (touches gate/sentinel decision points + a provenance seam)`

## Summary of the change

Adds the quality-meter substrate the LLM-decision audit named as the real gap (ACT-1193 uniform provenance, ACT-1194 outcome grading). Three parts: (1) a **correlation spine** — every enrolled high-stakes AI decision mints a replay-proof correlation id (`AutonomousRunStore`, `IntelligenceRouter`, `decisionQualityTypes`) so cost, provenance, and outcome all thread to one decision; (2) **uniform provenance** — `JudgmentProvenanceLog` recording extended from 2 callsites toward the full surface via `DecisionQualityRecorderImpl`, a 59-point census (`provenanceCoverage.ts`) and a shrink-only coverage ratchet; (3) **outcome grading** — a deterministic, evidence-triggered pass (`decisionGradingPass.ts`, `ExternalHogDecisionStore`, `AutonomousRealCheckAnnotator`) that stamps each recorded decision `right`/`wrong`/`unknown`, surfaced read-only at `GET /decision-quality` with a `POST /decision-quality/grade-pass` job, backed by 4 new `FeatureMetricsLedger` tables + a canonical view. The whole meter ships **dark + dryRun** behind `provenance.uniformSeam` (dev-gated; `dryRun` default true → metadata-only would-writes, nothing durable). Two live production bug fixes ride the same PR: `fileRoutes` no longer serves/edits the raw decision-provenance log (ACT-1200), and `BackupManager` per-file exclusion can no longer be bypassed (ACT-1201).

## Decision-point inventory

- `ExternalHogSentinel` kill decision (`ExternalHogScanTick`/`ExternalHogDecisionStore`/`ExternalHogServerPrimitives`) — **pass-through + record** — the kill verdict is UNCHANGED; the change only *records* provenance and grades on-supersede, and the durable write is suppressed while `dryRun`.
- `CompletionEvaluator` (completion / P13-stop judge) — **pass-through + enroll** — the judge verdict is unchanged; it now mints/carries a correlation id (provenance enrollment). Realcheck-based grading of this customer is the tracked fast-follow ACT-1202, NOT in this build.
- `decisionGradingPass` grade-stamp — **add (signal only)** — deterministic evidence rules stamp right/wrong/unknown. Never gates, blocks, or acts.
- `GET /decision-quality` / `POST /decision-quality/grade-pass` — **add (read + job)** — 503 when the seam is dark; Bearer-authed; pool branch field-allowlisted.
- `fileRoutes` serve/edit of the JP log — **add block (ACT-1200)** — deterministic path-based deny of a known-sensitive internal log.
- `BackupManager` per-file exclusion — **modify (ACT-1201)** — closes a bypass so an excluded file stays excluded (incl. restore).

---

## 1. Over-block

The meter itself has no block/allow surface — it records and grades; it never rejects an input. Over-block is only in scope for the two ride-along fixes:

- **fileRoutes (ACT-1200):** the new deny is scoped to the decision-provenance log path(s), not a broad prefix. A legitimate project file that merely *contains* "provenance" in its name is not blocked — the deny matches the concrete JP-log location, verified by `tests/unit/fileRoutes-never-served.test.ts`. Risk of over-block: low, path-exact.
- **BackupManager (ACT-1201):** enforcing an exclusion cannot over-exclude a file the operator didn't list — the change makes the *configured* exclusion actually apply; it adds no new patterns.

---

## 2. Under-block

- **fileRoutes:** the deny covers the JP log; other internal `.jsonl` audit logs under `logs/` were already never in the file-browser's editable roots — but any FUTURE internal log added to a served root would need its own guard. Named residual, not introduced here.
- **Grading under-block N/A** (not a block surface). The honest under-grade risk instead: an outcome whose evidence never arrives stays `unknown` (correct, not a miss); an outcome graded before its evidence window closes could mis-stamp — mitigated by evidence-triggered grading (the pass only stamps when the deterministic signal is present) + idempotent re-reads.

---

## 3. Level-of-abstraction fit

Correct layer. Provenance recording lives at the decision recorder (`DecisionQualityRecorderImpl`), not smeared across each callsite; grading is a separate periodic consumer, not inlined into the gate that made the decision (so a gate never blocks on grading). The census/ratchet enforce coverage at the data layer where the contract lives. The meter feeds the existing `feature_metrics` cost surface rather than creating a parallel one — it extends, not duplicates.

---

## 4. Signal vs authority compliance

Compliant. The quality meter is a pure **signal producer** — it records what a decision saw and grades how it turned out; it holds NO blocking authority and changes no verdict. Grading is deterministic evidence-rule stamping, never an LLM re-judgment in this build (the LLM evidence-interpreter is explicitly deferred, FD12/ACT-1198). The two ride-along fixes DO add blocking authority, but each is **deterministic and narrow** (a path-exact file deny; an exclusion-list enforcement) — not brittle heuristics with broad authority. `docs/signal-vs-authority.md` respected: no brittle check gained blocking power.

---

## 5. Interactions

- Extends `feature_metrics` (adds tables + a view) — additive; existing cost rows/reads untouched (`FeatureMetricsLedger-quality.test.ts`, `CircuitBreaking-feature-metrics-tap.test.ts`).
- Retrofits the `/judgment-provenance` pool branch with the same credential guard used by the new `/decision-quality` pool branch — one shared guard, no double-fire.
- `grade-pass` classified in `WriteDomainRegistry` (`pool-scope-read-merge`, machine-local) so multi-machine write-admission doesn't misroute it.
- The dryRun gate suppresses the durable `persist()` in `ExternalHogDecisionStore` while keeping in-memory grade-on-supersede + would-write logging — so nothing double-writes, and enabling the seam later can't retro-corrupt.
- `evolutionActions.autoExpiry` cannot sweep the three deferred ACTs (they're pinned/critical-class per spec §5.6) — no race with queue cleanup.

---

## 6. External surfaces

- New API routes (`GET /decision-quality`, `POST /decision-quality/grade-pass`) — 503 when dark, so on the fleet (seam off) they are inert. CLAUDE.md template + `CapabilityIndex` updated (agent-awareness); `PostUpdateMigrator` migration for existing agents (`decision-quality-claudemd-migration.test.ts`).
- New job template `llm-decision-grading.md` ships `enabled:false`.
- No message-path, dispatch, or session-lifecycle surface changes. No timing/conversation-state dependence beyond the grading pass's own keyset cursor (idempotent).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, proxied-on-read.** Provenance + grade rows are written machine-local (a decision happens on one machine; its evidence matures there). Reads merge across machines via the `?scope=pool` branch on `/decision-quality` (field-allowlisted so a hostile peer can't inject fields), matching the existing `/judgment-provenance` pool pattern. Cross-machine outcome ROUTING (a decision on machine A graded by evidence that lands on machine B) is explicitly deferred with honest-degradation shipping now — tracked **ACT-1199**. No user-facing notice surface here (API-only; dashboard is ACT-1197), so no one-voice gating needed. Durable state is per-machine and does not strand on topic transfer (it's not topic-keyed).

---

## 8. Rollback cost

Low. The meter is dark/dryRun behind `provenance.uniformSeam` — the back-out for the whole grading/provenance surface is to leave the flag off (fleet default) or set `dryRun:true`; nothing durable was written. The two live fixes are two-file, self-contained denials — rollback is a revert of `fileRoutes.ts` / `BackupManager.ts` via hot-fix release, no data migration, no agent-state repair. No schema destruction: the 4 new tables are additive and unused while dark.

---

## Second-pass review

_(Appended by the dedicated reviewer subagent — Phase 5, required: this change touches sentinel/gate decision points and a provenance seam.)_

**Concur with the review.**

Independently verified against the code, not the prose:

1. **Signal-only holds end-to-end.** `decisionGradingPass.ts` only calls `annotate(...)` (never gates); the `POST /grade-pass` handler (routes.ts:15358) just runs `runDecisionGradingPass`; `ExternalHogSentinel.recordDecisions` (ExternalHogSentinel.ts:237-252) is pure observation — `store.record()` throws are swallowed into `dqStoreErrors`, so a persist failure can never alter the kill verdict.

2. **dryRun is correct.** `this.dryRun = opts.dryRun !== false` (ExternalHogDecisionStore.ts:398, default TRUE); grade-on-supersede runs in-memory *before* the `if (this.dryRun) logWouldPersist()` else `persist()` branch (lines 528-583); `logWouldPersist` emits ledgerKey-count + byte-size only (line 473), no content. The pass treats a suppressed write as PENDING and does NOT advance the cursor (decisionGradingPass.ts:167-171) — a later `dryRun:false` flip won't skip ungraded rows.

3. **Both fixes narrow.** `NEVER_SERVED_PREFIXES` is path-exact (fileRoutes.ts:97-117); `isDeniedForBackup` reuses three existing layers and is applied in dir-copy *and* restore (BackupManager.ts:353, 494).

4. Both routes 503 when dark (15300/15359). 5. `pickDecisionQualityPointFields` is a real field allowlist applied instead of `{...row}` (15337); grade-pass classified machine-local in WriteDomainRegistry.ts:403. 6. Every deferral carries an ACT id; the "out of scope" mentions are non-goals, not dropped work. No missing failure mode.
