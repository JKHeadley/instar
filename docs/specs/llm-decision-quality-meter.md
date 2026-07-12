# LLM-Decision Quality Meter — uniform provenance + outcome grading

**Status:** DRAFT (pre-convergence)
**Tracks:** ACT-1193 (uniform full-context provenance), ACT-1194 (outcome grading over time)
**Source audit:** `docs/audits/llm-decision-accountability.md` (CMT-1962, Rounds 1–2)
**Parent standard:** Decision Provenance & Outcome Review (docs/STANDARDS-REGISTRY.md)
**Explicit non-scope:** ACT-1195 (bench prompt-parity) — separate follow-up. ACT-1196 (speaker-election enforce flip) — separate gate.

## 1. Problem

Instar has a cost meter for its LLM decisions, not a quality meter. The operator's stated goal
(2026-07-10 topic 11960): judge an LLM feature's performance in a scenario over time, to decide
whether a bigger model or a prompt change is warranted. Today that judgment is impossible:

1. **Provenance is not uniform.** `feature_metrics` records cost (tokens/latency), model/framework/door,
   and outcome-CLASS (fired/noop/error/shed) — but no field carries WHAT the decision was made on.
   The mechanism the ratified standard mandates — `JudgmentProvenanceLog` — exists but is wired to
   exactly TWO callsites (SpawnAdmission at server.ts:21699 and DuplicateSessionReconciler at
   server.ts:21914 — recon corrected the audit's "one"), both deterministic floors
   (`fallbackRung:'deterministic'`). Zero LLM gates/sentinels/judges write to it. Ad-hoc per-feature
   JSONL logs (response-review-decisions.jsonl, sentinel-events.jsonl, principal-coherence.jsonl)
   capture inputs inconsistently. A past decision cannot be reliably reconstructed for review.
2. **The highest-consequence decisions are the least logged.** The external-hog KILL decision
   (ExternalHogScanTick.ts:165) records no durable facts/verdict/prompt in default wiring. The
   autonomous continue/stop + P13 hard-blocker judges (CompletionEvaluator.ts:144/231) — which gate
   whether a run keeps burning budget — durably log no judged transcript slice, prompt, or verdict.
3. **Outcome grading is absent.** `verdictId` is a live schema column designed for verdict↔outcome
   correlation; no LLM row ever sets it (both `classifyVerdict` callers return `{acted}` only).
   `annotateOutcome` (JudgmentProvenanceLog.ts:203) has zero production callers. There is no periodic
   grading of any LLM decision against ground truth; the only real graders are two bespoke loops
   (CartographerSweep deterministic validation; correction-learning recurrence verify).
4. **Nothing ratchets.** A new LLM decision point that skips provenance passes CI clean. The standard
   is honored by prose for LLM decisions — exactly the "documented-only" enforcement class the
   audit-convergence work just eliminated for audits.

## 2. Goals

- G1 (ACT-1193): ONE uniform, opt-in-per-decision-point provenance path such that a gate/sentinel/judge
  decision can later be reconstructed (input context, prompt identity, verdict, model/door) — riding the
  existing JudgmentProvenanceLog storage/redaction/retention posture, not a second mechanism.
- G2 (ACT-1193): the two named high-stakes callsites (external-hog kill, completion/P13 judges) actually
  wired as the first customers, in this build — not deferred.
- G3 (ACT-1194): verdict↔outcome correlation made real: LLM rows carry a verdictId that links the
  feature_metrics row to the provenance record; `annotateOutcome` gains production callers so a decision's
  real-world result (e.g. "the killed process's owner was in fact dead"; "the run judged done was done")
  is recorded when it becomes known.
- G4 (ACT-1194): a periodic grading surface the operator can read: per decision-point, over a window —
  decisions made, outcomes known, grade distribution (right/wrong/unknown), trend — sufficient to answer
  "does this gate need a bigger model or a prompt change?".
- G5: a structural guard (census/ratchet) so a NEW LLM decision point must declare its provenance
  posture (wired / argued-exempt) — the same declare-or-fail pattern as the bench-coverage ratchet.

## 3. Non-goals

- No automatic model swaps or prompt changes from grades (the meter informs the operator; routing
  changes stay operator-gated — INSTAR-Bench remains the routing authority).
- No grading-LLM authority over live behavior: grading is observe-only, never gates.
- No full-content transcript retention beyond the provenance log's existing machine-local,
  retention-bounded, never-HTTP-served-raw posture.
- Not retrofitting all ~60+ decision points in one PR: the uniform seam + the named high-stakes sites +
  a census that makes the remaining retrofit backlog visible and ratcheted (no silent skips).

## 4. Design principles (constraints to converge against)

- **One seam, not 107 edits.** Provenance capture must attach at (or immediately adjacent to) the single
  LLM-funnel chokepoint that already writes feature_metrics rows, so callsites inherit the correlation id
  by construction; the per-point opt-in adds the decision CONTEXT, not the plumbing. (Exact seam:
  §recon — pending.)
- **Provenance content stays machine-local** (JudgmentProvenanceLog posture: local disk, bounded
  retention, redacted-only HTTP read). feature_metrics carries only the POINTER (verdictId), never
  context payloads.
- **Fail-open, signal-only.** A provenance write failure must never fail or delay the decision call
  itself — but it must be loud in the ledger (error-row / degradation), never silently dropped
  (Silent-Loss Refusal Conservation).
- **Grading is evidence-first.** Outcome annotation prefers ground-truth events (process came back /
  run actually completed / operator reversed the action) over LLM re-judgment; an LLM grader is the
  fallback interpreter of evidence, and its own calls are attributed + benched (Token-Audit
  Completeness).
- **Cost-bounded.** The grading job rides LlmQueue (spend caps, priority lanes) and ships
  `enabled:false` like every cost-bearing background job; the provenance path adds no LLM calls at all.
- **Ships dark/dryRun** per the graduated rollout ladder; no other feature's rollout flags are touched.

## 5. Mechanism (grounded — recon complete for 5.1/5.2; 5.3/5.5 anchors pending third recon pass)

### 5.1 The correlation spine — one seam, minted per decision

Recon-established facts (all verified on upstream/main @ 61d24370a):
- EVERY internal LLM call rides `buildIntelligenceProvider` (src/core/intelligenceProviderFactory.ts:146-261);
  every arm returns through `wrapForFunnel` (:139-144) = breaker OUTSIDE, spawn-cap INSIDE. No provider is
  constructed outside the factory (bypass grep: zero hits in src/).
- The ONE metrics chokepoint: `CircuitBreakingIntelligenceProvider.recordMetric` →
  src/core/CircuitBreakingIntelligenceProvider.ts:165 (shed :198, success :242, error :262). Feature key
  = `options?.attribution?.component ?? 'unlabeled'` (:179). Recorder singleton injected once at
  AgentServer.ts:1173.
- `evaluate` returns `Promise<string>` only (types.ts:970); the additive extension pattern is the
  `onUsage`/`onModel`/`classifyVerdict` callbacks (types.ts:1086-1112). `classifyVerdict` has exactly 2
  callers (MessageSentinel.ts:711, CommitmentSentinel.ts:339); neither sets `verdictId` → every
  `kind:'llm'` row writes `verdict_id = NULL` today.
- Failure-swap means ONE logical decision can emit N metric rows (one per attempted framework); only
  `IntelligenceRouter.evaluate()` (src/core/IntelligenceRouter.ts:943+) still sees the decision as one
  call. `feature_metrics.verdict_id` (FeatureMetricsLedger.ts:269) is write-only — no SELECT references it.

Design (the convergence review arbitrates the A/B choice, §6-Q1):
1. A per-DECISION correlation id is minted at the router level (one logical decision = one id) and
   threaded down through `IntelligenceOptions` (additive field), so every swap-attempt metric row of the
   same decision stamps the SAME `verdictId`. Callsites inherit it with zero edits.
2. An opting-in callsite adds an additive `options.provenance` block: `{ decisionPoint, context,
   optionsPresented, promptId? }` — the DecisionRowInput fields the caller uniquely knows
   (JudgmentProvenanceLog.ts:51-70 already defines the envelope; the log already carries model/door/
   tokensIn/tokensOut/latencyMs and `arbiter` + `fallbackRung` axes).
3. When `options.provenance` is present, the funnel seam writes the `JudgmentProvenanceLog.recordDecision`
   row at call completion — combining the caller's context block, the classified verdict (from the
   existing `classifyVerdict` callback where implemented, else the raw-response head), and the
   usage/model/door the seam already observes — and stamps the correlation id on both stores. LLM-arbiter
   rows set `arbiter:true` (bypasses sampling — JudgmentProvenanceLog invariant).
4. Provenance write failures are catch-logged (the log's own observability-only failure semantics);
   the decision call is NEVER failed or delayed by its audit trail.

### 5.2 The decision-context envelope

`DecisionRowInput` IS the envelope — no new schema. All existing invariants ride along unchanged:
write-time credential scrub to `contextRedacted` (2000-char clamp), `contextFull` machine-local only
(0700/0600, gitignored, backup-excluded, never-HTTP-served via NEVER_SERVED_PREFIXES), 64KB row clamp
truncate+flag, 14-day retention, async buffered appends, deterministic FNV-1a sampling with arbiter
bypass, redaction-by-field-omission at the only read surface (`readRedacted`, :314). The redaction
contract stays a code invariant, never config (types.ts:4167-4172 doc pin).

### 5.3 High-stakes first customers (anchors verified)

- **External-hog kill/leave** — decision loop at ExternalHogScanTick.ts:163-223. At the decision instant
  the code holds: the deterministic floor verdict (`evaluateKillFloor(cand.facts)` :164), the classifier
  raw output (:165) + parsed verdict `kill|leave|alert|null` (ExternalHogClassifier.ts:27-45), the full
  `ExternalHogFacts`, identity (`commandHash/ledgerKey/classId`), breaker + SelfActionGovernor admission
  state. Durably logged today: NOTHING decision-level — `ScanOutcome[]` is in-memory last-16
  (ExternalHogSentinel.ts:153); the per-tick audit row is counts-only AND unwired in default primitives
  (emitAudit early-returns, ExternalHogSentinel.ts:215; server.ts:17965-17985 never passes `auditRow`).
  This build wires `recordDecision` (component `ExternalHogClassifier`, `arbiter:true`) with facts +
  floor + verdict + prompt identity, at the same decision loop.
- **Completion + P13 judges** — CompletionEvaluator.ts: `evaluate()` :140 (LLM call :144-150, component
  `CompletionEvaluator`) and `evaluateStopRationale()` :226 (call :231-237, component
  `CompletionEvaluator/P13`). Durably logged today: verdict returned to the stop hook + a terminal
  run-state flag (routes.ts:5445); no prompt/transcript-slice/verdict content persists. This build wires
  `recordDecision` with the transcript-slice IDENTITY (hash + bounds — never the full transcript; the
  provenance context must not become a second transcript store), the StopSignals corroboration block,
  verdict + reason.

### 5.4a Q2 resolved — LlmQueue is not a second seam

LlmQueue consumers enqueue closures that call `router.evaluate(...)` (e.g. CartographerSweepEngine.ts:688)
— the queue is a scheduling/spend wrapper ABOVE the funnel, not a bypass. The funnel chokepoint remains
the single metrics/provenance seam.

### 5.4 Outcome annotation — making `annotateOutcome` real

`annotateOutcome(decisionId, component, outcome)` (JudgmentProvenanceLog.ts:203) has zero production
callers. This build adds ground-truth-first callers keyed on the §5.1 correlation id:
- External-hog: on kill → later evidence rows (process respawned by owner? operator reversed?) grade the
  kill; on leave-alive → sustained-hog recurrence grades the spare.
- Completion judge: a met:true verdict followed by a realcheck pass/fail, or a stop followed by an
  operator "keep going" correction, grades the judgment.
- The generic path: any subsystem holding the correlation id may annotate when its ground truth lands.

### 5.5 The grading read surface + periodic job (anchors verified)

- FeatureMetricsLedger gains a verdict-aware read (decisions ↔ outcomes joined per feature/window) —
  closing the "verdict_id is write-only" gap (no SELECT references the column today).
- Grading prior art to consolidate, not reinvent (both non-LLM): Cartographer's deterministic
  ground-truth check (validateSummaryDeterministic, cartographerSummary.ts:115-128 — summary must name a
  symbol verifiably present in the code) and correction-learning's recurrence + persistence verify
  (CorrectionLoopDriver.runVerification, :330-380 — recurrence reopens; silence alone is never
  'verified'; "silence ≠ effective"). The generic grading path follows the same evidence-first shapes:
  ground-truth check where one exists, recurrence/persistence where it doesn't, honest `unknown` otherwise.
- The periodic grading job is a declarative agentmd built-in (src/scaffold/templates/jobs/instar/
  <slug>.md picked up by InstallBuiltinJobs.ts:106-116): `schedule` cron + `model: haiku` +
  `supervision: tier1` + `enabled: false`, whose body drives a NEW deterministic grading endpoint —
  the Tier-1-LLM-wraps-deterministic-tool pattern of correction-analyzer.md / feedback-factory-process.md.
  Any LLM interpretation inside the endpoint rides `llmQueue.enqueue('background', fn, costCents)`
  (LlmQueue.ts:96-122; daily cap default 100¢, interactive reserve honored, abort signal honored) —
  exactly how CartographerSweep rides it (CartographerSweepEngine.ts:688).
- Read surface: `GET /decision-quality` (or a `quality` block on `/metrics/features` — §6-Q3): per
  decision-point over a window → decisions, outcomes-known ratio, grade distribution
  (right/wrong/unknown), trend. Serves REDACTED provenance pointers only.

### 5.6 The census/ratchet — no silent skips (G5)

Same declare-or-fail pattern as LLM_BENCH_COVERAGE + componentCategories (componentCategories.ts:36-148,
62 attributed components today): a PROVENANCE_COVERAGE declaration per LLM component —
`wired | pending:<ACT> | exempt:<argued reason>` — with a ratchet test that fails CI when an attributed
component lacks a declaration. The backlog of not-yet-wired points becomes visible and pinned instead of
silent.

### 5.7 Config + rollout

- `provenance.uniformSeam` (new, dev-gated dark → dryRun-first on dev): stage the seam write itself.
- Grading job manifest ships `enabled:false` (cost-bearing job class).
- No other feature's rollout flags are touched. Config keys nested under the existing `provenance` block
  (types.ts:4167).

## 6. Open questions for convergence

- Q1 verdictId minting: (A) breaker-local — JP row id stamped on the deciding row only, failed swap
  attempts uncorrelated; vs (B) router-minted decision id threaded via IntelligenceOptions — all N
  attempt rows share it, JP row carries it. Recon says only the router sees one-decision-as-one-call;
  B is the working draft, A is simpler.
- Q2 RESOLVED (recon pass 3): LlmQueue consumers call router.evaluate inside their enqueued closures —
  the queue is above the funnel, not a bypass. One seam confirmed.
- Q3 Read surface placement: new /decision-quality route vs a quality block on /metrics/features.
- Q4 Grade taxonomy: right/wrong/unknown global vs per-point custom scales — what the operator reads.
- Q5 Sampling interaction: opted-in NON-arbiter deterministic-adjacent decisions vs the sampling knob.
