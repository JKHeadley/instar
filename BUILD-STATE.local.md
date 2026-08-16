# BUILD STATE — llm-decision-quality-meter (survives session death; update per phase)

Spec: docs/specs/llm-decision-quality-meter.md — CONVERGED r7, stamp earned (9d0e0997e).
Approval: PENDING (sign-off sent to topic 11960 ~20:50 PDT 2026-07-11; CMT-1964 carries the gate).
Rule: BUILD everything + full local tests NOW; COMMIT through the /instar-dev gate ONLY after
operator `approved: true`. (Pattern proven earlier tonight on the audit-enforcement build.)
Branch: echo/llm-decision-quality-meter (this worktree). 24h run topic 11960, ends 12:06 PDT Jul 12.
(Prior pre-convergence recon notes superseded by the spec + REVIEW-STATE.local.md; key recon facts:
two JPL callsites server.ts:21699/21914; funnel chokepoint CBIP.recordMetric:165; verdict_id NULL +
write-only on llm rows; onUsage/onModel/classifyVerdict = the extension seam; 62 components.)

## Build phases (spec §5 + §Testing are the authority; REVIEW-STATE.local.md has the full trail)

- [x] P1. DONE (fileRoutes dual-root + 3-layer per-file deny incl. RESTORE path; 20/20+4/4+73/73+66/66 green, tsc clean)  P1. Live-defect fixes (self-contained; ride this PR per spec):
      (a) fileRoutes NEVER_SERVED dual-root fix — existing 'state/judgment-provenance/' entry is a
          production NO-OP (projectDir-rooted matching); add '.instar/state/judgment-provenance/' +
          '.instar/state/external-hog-decisions.json' literals; fix the unit test to seed the
          PRODUCTION layout (<projectDir>/.instar/state/...). ACT-1200.
      (b) BackupManager: add 'state/external-hog-decisions.json' to BLOCKED_PATH_PREFIXES +
          'external-hog-decisions.json' to NEVER_BACKUP_PATH_SEGMENTS; per-file re-check in
          createSnapshot dir-copy branch applying ALL THREE deny layers (BLOCKED_FILES +
          BLOCKED_PATH_PREFIXES + NEVER_BACKUP_PATH_SEGMENTS) to path.join(entry, file); restore
          path: apply same deny checks at restoreSnapshot (spec allows either; checks are cheap —
          do it). Threat-shaped tests: ['state/'] + remediation OFF → omits store + siblings
          (pr-hand-leases, self-action-governor, pending-inbound); ['./'] → omits config.json.
          ACT-1201.
- [x] P2. DONE (decisionQualityTypes.ts spine module + router mint/settle/per-attempt-capture + breaker floor w/ marker single-use + verdict_id always-on kind:llm single-writer + callerRef relocation; 35/35 spine + 20/20 tap + 55/55 nature + 258 router/breaker sweep + FULL UNIT SUITE 36,638 pass [2 strays resolved: own doc-comment ratchet FP reworded; builtin-manifest transient race]; tsc + full lint chain clean. Recorder iface: DecisionSettlement → setDecisionQualityRecorder, default no-op. Deviations logged in agent report: verdictClass=fired|noop|unclassified at seam [richer classes = recorder layer], clamps/dryRun/census-validate = recorder layer [P3/P6], marker=per-object deletion semantics, mintedBy narrowed to router)  P2. Correlation spine (§5.1): router mint on INTERNAL clone (d-<machineId8>-<uuid>), single-use
      marker, breaker floor (b- mints, inbound-id discard, marker consumption), verdict_id stamping
      ALWAYS-ON kind:'llm' single-writer (callerRef relocation + types.ts:1112 doc update),
      per-attempt capture scoping, onCorrelationId (mint-time, try/catch, exactly once),
      options.provenance strip at BOTH router and funnel wrapper, settlement write-once on EVERY
      exit incl. errored (decision:'<errored>').
- [ ] P3. JPL envelope extensions (§5.2): correlationId/promptId/contentClass/mintedBy fields;
      serve-discipline invariants (bounded decision field; charset clamps optionsPresented/
      verdict_class/promptId; content classes + envelope builders; dry-run metadata-only).
      FD9: JPL construction OUT of mesh block (unconditional); routes 503-text + CapabilityIndex
      /judgment-provenance text updates.
- [x] P4. DONE (4 tables + decision_winning_grade VIEW canonical derivation + getWinningGrades API; recordDecision/upsertOutcome/bumpQualityCounter/reconcile/prunes; AgentServer timer quality arm; 20/20 + 96 adjacent green, tsc clean. NOTE: pruneGradingCursors called staleness-only until census ids threaded — P9)  P4. Quality substrate (§5.5): 4 SQLite tables (decision_quality, decision_outcomes,
      decision_quality_rollup, decision_grading_cursor) owned by FeatureMetricsLedger SCHEMA array;
      canonical winning-grade view (ONE derivation, both consumers); rollup mutation semantics
      (decision-UTC-day bucket, decrement-on-supersede, boot + 6h-timer reconcile w=30d);
      prunes ride the 6h timer + construction-condition quality arm; indexes
      (decision_point, ts, correlation_id) + partial on correlation_id.
- [x] P5. DONE (src/data/provenanceCoverage.ts: 59 entries — 3 wired [hog key = ExternalHogClassifier per live attribution], 50 pending:ACT-1193, 6 exempt; RULE_REGISTRY 6 rules; SUBBUDGET_IMPLEMENTED=false; 23/23 green, tsc clean. HANDOFF: WIRED_AWAITING_ENROLLMENT array in ratchet test — P7/P8 MUST shrink it when wiring; rule-owner note: hog-leave-recurrence right-half may need a DecisionGrading-owned sibling rule if P9 issues it)  P5. Census module (§5.6): src/data/provenanceCoverage.ts — typed PROVENANCE_COVERAGE registry
      (decision-point ids exported; volumeClass; contentClass; composition; status
      wired|pending:<ACT>|exempt:<closed taxonomy>); ruleId→rung+strength+owningComponent registry
      co-located; ratchet test (declare-or-fail vs COMPONENT_CATEGORY, key uniqueness ALL entries,
      exempt+pending baselines pinned shrink-only, >2-enrolled→sub-budget assertion, typed-import
      check, informational callsite count).
- [ ] P6. annotateOutcome write-integrity (§5.4): correlationId keying, rung/strength/owner from
      registry (reject+count mismatches: enum-invalid/rung-mismatch/owner-mismatch/
      unknown-decisionPoint), precedence + within-rung conservative, upsert on
      correlationId×gradedBy, outcomes → decision_outcomes table.
- [x] P7. DONE. The store + FactBuilder/ScanTick wiring + evidence rules were built in the earlier
      wave; the FINAL construction-site wiring (the TODO(P6-handoff) block) landed this session:
      (1) server.ts evaluate lambda now forwards the §5.3 provenance block into
      `sharedIntelligence.evaluate` (unconditional — minting is always-on; the decision_quality WRITE
      is gated inside the recorder).
      (2) server.ts constructs `ExternalHogDecisionStore` + passes the 3rd `{ decisionStore, annotate }`
      arg to `new ExternalHogSentinel`. `annotate` maps HogOutcomeAnnotation → the recorder's
      DecisionOutcomeAnnotationInput via `annotateDecisionOutcome` (ruleId is TOP-LEVEL on the input but
      NESTED in gradedBy on the hog annotation — the task's literal `annotateDecisionOutcome(a)` does not
      typecheck; the field-map is the correct wiring, result discarded since annotate is void).
      `killLedgerBreakerWindowMs: 3_600_000` == `breaker.windowMs` (§5.3 retention derivation), commented.
      (3) dryRun gating (the load-bearing decision): the store now carries a `dryRun?` flag
      (option (a) — "thread a dryRun flag into the store"), defaulting TRUE to MIRROR the recorder's
      `dryRun !== false` safe default. In dryRun, `record()` still runs grade-on-supersede IN-MEMORY (so
      the annotate would-write soak stays complete — option (c) "don't construct in dryRun" would have
      killed it via recordDecisions()'s `if (!store) return`) but SUPPRESSES the durable persist and
      emits a metadata-only would-write line. Justified by spec §5.2 L312-316 + §5.7 L734/L745 + Testing
      L833 ("dry-run suppresses ALL durable writes"). The SEAM state is resolved the SAME way as the
      recorder: server.ts computes `_dqSeamEnabled = resolveDevAgentGate(config.provenance.uniformSeam.enabled, config)`
      (gates store construction — store built ONLY when the seam is live) and `_dqSeamDryRun =
      config.provenance.uniformSeam.dryRun !== false` (threaded into the store). Existing store +
      decision-wiring test makeStore helpers gained `dryRun:false` (they exercise the LIVE persist path;
      the behavior-changes-break-old-tests sweep). New §5.2 threat-shaped test block (3 tests): dryRun →
      NO file written + in-memory record + metadata-only would-write line (asserts no pid/hash/corr-id
      leak) + grade-on-supersede still fires; dryRun:false → file written + hydrates. tsc clean;
      74 + 64 + 3(e2e) green; no-silent-fallbacks ratchet green (one new tagged catch); dev-gate lint clean.
      RESIDUAL (honest, unchanged from P8b): the realcheck-outcome annotator (AutonomousRealCheckAnnotator)
      still has an UNBOUND P6-handoff at the bash-stop-hook surface (completion-realcheck-v1) — out of this
      route/construction-layer scope, tracked in P8's residual note.
- [x] P8. DONE (both evaluator callsites enroll via options.provenance — DP_COMPLETION_EVALUATE /
      DP_COMPLETION_STOP_RATIONALE, transcript-slice-IDENTITY envelope built inline [TODO(P3-handoff)
      swap to §5.2 builder], optionsPresented = real emitted token spaces MET/NOT_MET + STOP_OK/
      STOP_BLOCKED, promptId = existing PROMPT_VERSION consts; verdicts additively carry
      correlationId; correlation id persisted via AutonomousRunStore.recordDecisionCorrelation →
      lastCompletion/lastStopRationale fields on the durable run record [restart-proven in tests];
      NEW src/core/AutonomousRealCheckAnnotator.ts implements the three §5.3 arms against an
      INJECTED annotate fn — P6 chokepoint binding is a marked TODO(P6-handoff), callers pass null →
      'annotate-unbound'. Ratchet: 2 completion lines removed from WIRED_AWAITING_ENROLLMENT.
      31/31 new + 48/48 adjacent green; tsc clean at build time. INTEGRATION (a) DONE (wave-3):
      server.ts:16629 constructs CompletionEvaluator with runCorrelationSink = a file-backed
      AutonomousRunStore(config.stateDir) [same-stateDir throwaway-instance, coherent with the routes'
      instance]; runRef {topicId,runId} now passed at ALL THREE callsites — routes.ts evaluate (5434,
      armedRecord-gated), breaker-trip stop-rationale (5357, armedRecord non-null), and the
      /autonomous/evaluate-stop route (5502, server-resolved active-record runRef). tsc clean; the
      autonomous-evaluate + completion-evaluator + scope-accretion suites green (35 tests). RESIDUAL
      (b) — NOT resolvable at this callsite, honestly deferred: bind the annotator at the
      realcheck-outcome surface. The realcheck RUNS IN THE BASH STOP HOOK; PASS reaches the server only
      as run_end "met", the FAIL arm + configured-bit need the hook to carry its realcheck outcome on
      the run-end body [hook marker bump] or a server read of logs/autonomous-realcheck.jsonl — a hook
      change out of this route-layer scope (the P6/hook-handoff TODO stays honest, not faked).  P8. CompletionEvaluator wiring (§5.3): both points volumeClass full; correlation id persisted
      in run-state; realcheck path annotates completion-realcheck-v1.
- [x] P9. DONE (POST /decision-quality/grade-pass in routes.ts + NEW src/core/decisionGradingPass.ts
      runDecisionGradingPass: deterministic-ONLY hog-sustained-right-v1 window-close grading over the
      durable ExternalHogDecisionStore; keyset cursor (ts, correlation_id) via NEW
      ledger.walkDecisionsForGrading; maxDecisionsPerPass ceiling; low-water-mark cursor over the
      UNIFORM evidence window [pending<window, terminal after]; idempotent through the annotate
      chokepoint [re-runs converge]; P19 backoff on no-progress; injected clock. Returns exactly
      { graded, byRule, cursors } — matches the job template's expected shape. NEW accessor
      ExternalHogSentinel.decisionStoreRef() feeds the store (null when the sentinel store is unwired →
      honest graded:0). Job template llm-decision-grading.md already shipped (P11, auto-discovered
      manifest — no InstallBuiltinJobs/migrateBuiltinJobs change needed). 7/7 grade-pass unit + route
      integration + e2e green; tsc clean. NOTE: `expired` is a READ-side derived state (P10), never
      written by the pass — the pass's terminal give-up = advancing the cursor past an ungraded row.)  P9. Grading endpoint + job (§5.5): POST /decision-quality/grade-pass (cursor keyset
      (ts, correlation_id), 200/pass ceiling, streamed JSONL under row budget, idempotent,
      P19 backoff + terminal expired); job template llm-decision-grading.md (hourly, haiku, tier1,
      enabled:false, curl-only body) + InstallBuiltinJobs + migrateBuiltinJobs.
- [x] P10. DONE (GET /decision-quality in routes.ts: Bearer; 503-when-seam-dark (resolveDevAgentGate on
      provenance.uniformSeam) AND 503-when-ledger-null; per-point aggregates grouped by evidence
      STRENGTH first + insufficient-evidence marker (outcomesKnown < minSampleForRates default 20);
      grade-by-rule/rung/strength; grade distribution right/wrong/unknown/expired (expired derived at
      read via NEW ledger.countExpiredByPoint over the evidence-carrier horizon); attribution columns
      (model/framework/prompt_id via NEW ledger.decisionPointStats); census debt wired/pending/exempt +
      pending-ref-dead (runtime action-queue resolve) + wired-but-silent + exempt-but-active flags;
      per-point + top-level orphan/joinMiss/droppedByBudget; the 4 rejection-class counters
      (getDecisionAnnotationRejectionCounters). NEW ledger.decisionGradeBreakdown consumes the
      canonical decision_winning_grade VIEW. ?scope=pool merges MACHINE-TAGGED peer rows with
      isPeerUrlAllowedForCredentials + per-row 8KB clamp + pool.failed classified rows + explicit FIELD
      ALLOWLIST (pickDecisionQualityPointFields — never {...row}). RETROFITTED the /judgment-provenance
      pool branch (routes.ts) with the SAME credential guard + a RedactedProvenanceRow field allowlist
      (pickRedactedProvenanceFields — strips contextFull + any hostile extra). CapabilityIndex
      decisionQuality prefixes filled (['/decision-quality']) — discoverability lint green.
      Pure indexed SQLite reads throughout (never a JSONL scan). 7/7 route integration + 3 e2e green;
      tsc clean.)  P10. Read route (§5.5): GET /decision-quality (Bearer; 503-when-dark; per-point window
      aggregates strength-first + insufficient-evidence marker n<20; grade-by-rule/rung/strength;
      attribution columns; census debt + pending-ref-dead + wired-but-silent + exempt-but-active;
      orphan/joinMiss/droppedByBudget + 4 rejection-class counters; ?scope=pool with peer-URL
      credential guard + field allowlist; RETROFIT the /judgment-provenance pool branch
      routes.ts:~15031 with same guard).
- [x] P11. DONE-partial (devGatedFeatures entry + coherence-manifest exclusion row + job manifest [auto-discovered, no InstallBuiltinJobs change needed] + config-unseeded verified/pinned; HANDOFF→P2/P3: types.ts provenance block needs uniformSeam+quality keys; CapabilityIndex /decision-quality entries → P10)  P11. Config + rollout (§5.7): provenance.uniformSeam DEV_GATED_FEATURES entry (omit-required,
      dryRun default TRUE); provenance.quality.* keys incl. minSampleForRates; grading job
      enabled:false; COHERENCE_MANIFEST_EXCLUSIONS row; migrateConfig NO-OP-by-design.
- [x] P12. DONE (DECISION_QUALITY_CLAUDEMD_SECTION single-source const in PostUpdateMigrator + generateClaudeMd interpolation + sniffed migrateClaudeMd; 335 + 226 adjacent green, tsc clean)  P12. Migration parity + agent awareness (§6): generateClaudeMd capability section + proactive
      trigger; migrateClaudeMd sniffed twin; CapabilityIndex updates.
- [x] P13. DONE for the P9/P10/P8-integration tiers this wave delivered (the broad unit/redaction/
      ratchet matrix below was already shipped by phases P2–P8/P11/P12 and re-verified green here):
      NEW tests/unit/decision-grading-pass.test.ts (7) — grade-pass cursor keyset + same-ms burst +
      batch ceiling + idempotent re-run + within-window-pending low-water + null-store no-op + perf
      assertion (50 empty passes < 500ms) + wiring-integrity (recorder singleton non-null delegates to
      the REAL ledger; CompletionEvaluator persists via a REAL runCorrelationSink, not a no-op) —
      injected clock throughout. NEW tests/integration/decision-quality-routes.test.ts (7) — GET
      200-with-data (grade distribution/byStrength/byRule/attribution/insufficientEvidence/censusDebt/
      rejections + evidence_note NEVER served) / 503-when-dark / 401-Bearer / ?scope=pool FIELD
      ALLOWLIST strips a hostile peer row's contextFull+extras / non-allowlisted peer URL → pool.failed
      (Bearer never travels) / grade-pass 503-when-dark + idempotent convergence. NEW
      tests/e2e/decision-quality-alive.test.ts (3) — REAL AgentServer single-machine boot →
      GET /decision-quality + POST grade-pass answer 200 (not 503) + 401-Bearer + the feature-metrics
      DB actually created on disk. Adjacent suites re-verified green: FeatureMetricsLedger-quality (20),
      DecisionQualityRecorderImpl (31), external-hog-sentinel + decision-wiring (11),
      completion-evaluator-provenance-enrollment (13), autonomous-run-store-decision-correlation (8),
      autonomous-evaluate-stop + signals (12), scope-accretion-routes (20), no-silent-fallbacks ratchet
      (baseline held at 492 after moving readLiveEvolutionActs to module scope), capabilities-
      discoverability (151), CapabilityIndex (10), llm-decision-grading-job-template (11). tsc clean;
      lint-dev-agent-dark-gate clean. RESIDUAL (honest): the FULL tests/ sweep is deferred to P14 per
      the DO-NOT-run-36k-suite constraint — this wave ran targeted files + directly-adjacent suites.)  P13. Tests (§Testing — ALL tiers): unit (id minting/marker/clamps/budget/cursor/store/
      annotate-integrity/rollup/canonical-view/onCorrelationId-throw/owner-rejection/
      insufficient-evidence both sides); redaction/scrub suite (argv exclusion, contextFull never
      crosses, NEVER_SERVED production layout BOTH stores, backup threat-shaped cases); integration
      (route 200/503/Bearer/pool/grade-pass); E2E feature-alive (single-machine boot → JP log
      constructed → route 200); wiring-integrity (dev-gate both sides, recorder singleton,
      machineId8, manifest exclusion row, prune-timer quality arm); ratchet fixtures; existing-test
      sweep (CircuitBreaking-feature-metrics-tap NULL-world update + full tests/ sweep);
      injected clocks everywhere; perf assertion.
- [ ] P14. Full local suite green + build clean → HOLD for approval → /instar-dev gate → PR →
      safe-merge on green CI.

## Notes
- Anchor line numbers in the spec are v-dist-current as of r7 review; re-ground each at touch time
  (INT5-m3 standing note).
- ZERO LLM spend in this build (grading deterministic-only; job ships disabled).
- Ship posture: everything dark/dry-run per FD6; NO rollout-ladder flips for other features.
- Run instructions: verification commands READ-ONLY (no /dev redirects); ship-narration via
  /telegram/post-update.

## Cross-builder flags (accumulate; clear at integration)
- P2 must add @silent-fallback-ok (or throw) to the catch in its new src/core/decisionQualityTypes.ts — no-silent-fallbacks ratchet is +1 vs baseline (P4 verified the +1 is that file).
- types.ts config interface: provenance.uniformSeam {enabled,dryRun} + provenance.quality {7 keys} — P2 owns types.ts; if P2 lands without it, patch at integration.

## Wave 2 dispatched (~21:40 PDT): W2a = P3+P6+recorder-impl+AgentServer-wiring+FD9+types-config-handoff (one builder — shared JPL write path); W2b = P7 hog store; W2c = P8 completion wiring. SHARED-FILE protocol: ratchet WIRED_AWAITING_ENROLLMENT — W2b removes hog line only, W2c removes 2 completion lines only, re-read-before-edit. Wave 3 after: P9+P10 as ONE builder (both routes.ts), then P13 full sweep + E2E/wiring/perf tiers.
