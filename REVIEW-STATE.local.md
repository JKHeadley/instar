# /spec-converge running state — llm-decision-quality-meter

Local orientation note (gitignored *.local.md). Survives session death; the convergence report is
authored from this ledger at the end.

## Round 1 (started 2026-07-11 ~18:22 PDT)

- Spec body hash at round 1: `d9cc6da3a24d8e1641ed0052655d9d19788f8afa5d3ef9780f01377578eca826`
- Standards-Conformance Gate: ran (3 flags):
  1. Constitutional Traceability — checker says parent standard "Decision Provenance & Outcome
     Review" not in its list (LIKELY checker staleness — deployed dist predates #1436 registry merge;
     integration + lessons reviewers asked to verify against worktree registry).
  2. Maturation Path — FD6 "dev-gated dark, dryRun-first on dev" flagged vs ships-enabled-on-dev
     standard; wording may be self-contradictory (integration reviewer asked to propose exact posture
     language).
  3. Testing Integrity — spec has no test-tier plan section. Real gap; spec needs a Testing section.
- Cross-model: codex-cli RAN ok (gpt-5.5) verdict SERIOUS ISSUES — 6 findings; gemini-cli RAN ok
  (gemini-3.1-pro-preview) verdict MINOR ISSUES — 4 findings. Clean-door claude-code: refused
  `no-supported-framework` (config-disabled on this agent) → disclosure only, not a cross-model pass.
  Detection recorded to state/framework-activation-history.jsonl (both families active → externals
  MANDATORY, no abbreviated skip permitted).

### Codex findings (r1-codex.json, scratchpad)
1. Correlation-id ambiguity §5.1/§5.4 — DecisionRowInput has no correlation-id field; recordDecision
   mints its own jp-* id; unclear whether feature_metrics.verdict_id stores router id, provenance row
   id, or both. → explicit schema/API: DecisionRowInput.correlationId, persisted on row; define
   annotation key (provenance row id vs logical decision id).
2. "Zero callsite edits" overclaim §5.1 — automatic correlation ≠ provenance enrollment (context/
   decisionPoint/prompt identity are callsite-specific). → separate the two concepts; specify the
   minimum per-callsite integration contract.
3. Outcome grading underspecified §5.4/§5.5 — "respawned/reversed/keep-going/realcheck" are domain
   signals without event sources, time windows, conflict handling, FP avoidance. → concrete outcome
   rules, deadlines, evidence sources, precedence for the two first customers.
4. LLM evidence-interpreter risk §5.5 — replacing one ungraded LLM judgment with another. → strictly
   deterministic grading for the two high-stakes sites initially; LLM interpretation only after a
   benchmarked evaluator exists.
5. Ratchet granularity §5.6 — component ≠ decision point (one component can hold several decisions).
   → ratchet on stable decision-point IDs.
6. Retention vs longitudinal grading §5.2/§5.5 — 14-day provenance retention too short for
   "over time" analysis; delayed outcomes dangle. → persist redacted decision/outcome SUMMARIES
   longer than raw provenance; explicit retention policy.

### Gemini findings (r1-gemini.json, scratchpad)
1. (minor) Jargon density — glossary/inline explanations for funnel seam / P13 / ratchet.
2. Redaction robustness — scrubber coverage is the load-bearing privacy guarantee; needs an explicit
   maintained test suite over sensitive-data formats for the NEW writer classes.
3. 64KB clamp truncation — may cut diagnostic detail; prioritize critical fields before truncation.
4. Seam overhead — JSON.stringify + scrub per opted-in call; profile recordDecision under load early.

### Internal reviewers (6, in flight — agent ids in session)
- security a267373287230c55d · scalability a26e559f839a06268 · adversarial a7a9f6c4e3a5267d9 ·
  integration a389b70e146ad1dc7 · decision-completeness a90c78faf5a8b209e · lessons-aware a4c216cff591ed768
- Results to be appended below when they land.

### D7 per-round model disclosure
- Internal reviewers round 1: claude-fable-5 (authoring session model, harness subagents).
- Externals: codex-cli:gpt-5.5, gemini-cli:gemini-3.1-pro-preview.

### Internal — SCALABILITY (landed, 4 MATERIAL + 2 minor)
S1 MATERIAL: /decision-quality JOIN has no substrate — outcomes live only in provenance JSONL; sole read
  is readRedacted (JPL.ts:314-352): whole-day fsp.readFile + SYNC split/JSON.parse per line on event loop
  (contextFull parsed just to discard); live volume 1,264 LLM calls/day, ~33KB avg → all-wired ≈ 40MB/day
  → 14-day window ≈ ~500MB sync-parsed per request; readRedacted limit-capped 1,000 rows — structurally
  can't compute window-wide distribution. FIX: compact quality substrate maintained at write/annotate time
  (decision_quality SQLite rows keyed on verdict_id); route NEVER scans JSONL; grading-job JSONL access
  streamed with per-tick row budget.
S2 MATERIAL: FD4 arbiter:true on every LLM verdict removes the sampling valve with no bound — CoherenceReviewer
  1,051 calls/day ~24KB; MessagingToneGate ~98KB avg input > 64KB clamp → every row pays degenerate 3×
  stringify clamp path, keeps only 8KB head. Log enqueue never refuses (no backpressure/shed). FIX: mandatory
  volume class per wired component in PROVENANCE_COVERAGE — full (bypass, rare high-stakes) | sampled:<rate> |
  budget:<rows/day> — enforced at seam + droppedByBudget counter; FD4 amended (bypass only for full-class).
S3 MATERIAL: correlation-id → outcome plumbing unspecified; join keys don't line up (recordDecision mints own
  row id returned to the SEAM not the callsite; annotateOutcome keys on row id; router.evaluate returns
  Promise<string>). FIX: (a) row carries correlationId first-class; (b) annotateOutcome accepts correlation id,
  join at read; (c) originating caller gets the id via synchronous callback in options block (onUsage pattern)
  and persists in ITS OWN durable state; (d) NO shared in-memory pending-outcome registry — unannotated ages
  out as unknown.
S4 MATERIAL: grading job unbounded — no cursor, no per-run ceiling, no idempotency; annotateOutcome is
  append-only → re-grade forever + duplicate outcome rows skew distribution. FIX: durable per-decision-point
  cursor, per-run batch ceiling, at-most-one-grading-outcome-per-decision (supersede/latest-wins at read).
S5 minor: verdict_id needs partial SQLite index (WHERE NOT NULL) or window-scan-only read shape.
S6 minor: pool guardrails — per-machine summary precomputed; future dashboard rides WS4.4(f) shared poll cache.
Verified-clean: not-opted-in cost ~zero; JPL write path genuinely async fail-open; LlmQueue real spend bound;
pool fan-out prior art bounded (5s abort + clamps).

## Phase-2 synthesis plan (findings in hand: codex 6, gemini 4, scalability 6, conformance 3) — DRAFT
- ONE-ID DESIGN (resolves codex1 + S3): router-minted correlation id becomes first-class `correlationId`
  on the provenance row; feature_metrics.verdict_id stores the SAME router id; annotateOutcome gains a
  correlationId-keyed variant (join at read); originating callsite receives the id SYNCHRONOUSLY via a new
  options callback (onUsage pattern) and persists it in ITS OWN durable state (hog ledger row / run state);
  explicitly NO shared in-memory pending-outcome registry — unannotated ids age out as unknown.
- SPLIT THE OVERCLAIM (codex2): §5.1 separates "automatic correlation" (zero callsite edits, true) from
  "provenance enrollment" (per-callsite contract: decisionPoint, context builder, optionsPresented,
  promptId — minimum contract table).
- COMPACT QUALITY SUBSTRATE (S1 + codex6 + S5): new small SQLite surface (decision_quality rows keyed on
  correlationId; verdict summary written at seam time, outcome at annotate time; ~200B/row) with its own
  longer retention (default 90d) — /decision-quality serves ONLY this substrate (indexed reads, partial
  index on correlationId); raw JSONL NEVER scanned by the route; grading-job full-context access streams
  line-by-line under a per-tick row budget. Raw provenance stays 14d.
- VOLUME CLASSES (S2 + codex5): PROVENANCE_COVERAGE declares per DECISION POINT (not just component; one
  component may hold several points) with mandatory volume class: full (arbiter bypass; rare high-stakes)
  | sampled:<rate> | budget:<rows/day>; seam enforces budget with droppedByBudget counter in status();
  FD4 amended — bypass only for full-class points.
- OPERATIONAL OUTCOME RULES (codex3 + S4): per first customer, a concrete rules table — evidence event
  source, observation window/deadline, precedence on conflict, FP guards; grading job gets durable
  per-decision-point cursor, per-run batch ceiling, at-most-one-outcome-per-decision (supersede at read).
- DETERMINISTIC-FIRST GRADING HARDENED (codex4): for the two first customers the grading ladder is
  deterministic/rule-based ONLY in this build; the LLM evidence-interpreter rung is spec'd but gated
  behind a benched evaluator (ACT-1195 family) — cannot activate before its battery exists.
- REDACTION + TRUNCATION (gemini2/3): Testing section gains a scrubber suite over the NEW writer classes'
  payload shapes (hog facts, transcript-slice identities); clamp path gains field-priority order (verdict/
  decision fields survive before contextFull bulk).
- FD6 POSTURE PRECISE (conformance flag 2): resolveDevAgentGate wording — LIVE on dev agent in
  observe/dryRun (logs would-write), DARK on fleet; graduation criteria named (dryRun soak N days on dev,
  written-row validation passes, then real writes on dev; fleet stays dark pending operator).
- TESTING SECTION (conformance flag 3 + gemini4): full tier plan — unit (id minting, clamp, budget,
  cursor), integration (route + auth + pool scope), E2E feature-alive, wiring-integrity (seam actually
  writes when opted-in under real server init), semantic boundary (graded right vs wrong vs unknown on
  both sides), perf assertion on seam overhead, scrubber suite, ratchet self-test.
- REPORT-ONLY NOTES: conformance flag 1 = checker staleness (standard IS at registry:522 in worktree);
  gemini1 jargon → glossary lines in ELI16, not the spec.

### Internal — DECISION-COMPLETENESS (landed, 6 MATERIAL + 4 minor; counts: FD=6, cheap=3, contested-cleared=2)
DC-M1: correlation-id RETURN path unspecified (evaluate returns string only; recordDecision row id goes to
  seam not caller; annotateOutcome keyed on JP row id ≠ correlation id; ProvenanceRow has no verdictId field).
  FIX: additive onCorrelationId callback (onModel pattern) fired once per logical decision; ProvenanceRow
  gains verdictId?; annotateOutcome accepts correlation id (or rule: seam sets JP row id = correlation id).
DC-M2: verdict_id semantic COLLISION — breaker already writes classifyVerdict's caller-supplied verdictId
  (documented types.ts:1112 "e.g. a commitment id"); FD1 destines same column for router-minted id. FIX:
  frontload — minted id ALWAYS occupies verdict_id; caller-supplied id moves to provenance context/outcome
  payload; types.ts doc updated same PR.
DC-M3: JP log constructed ONLY inside mesh block (server.ts:21611-21627); GET /judgment-provenance 503s
  single-machine. Seam has nowhere to write on the agents that will run it; either choice flips existing
  route 503→200 (fleet-visible). FIX: frontload — construction becomes unconditional (pure machine-local
  observability; route text updated) OR dual-gated (mesh OR uniformSeam) — pick one.
DC-M4: first-customer WRITE PATH ambiguity — seam-write vs direct recordDecision double-write; hog enacted
  action (killed/alert-only/floor-veto) unknowable at call completion (happens after LLM returns). FIX:
  seam writes the LLM-verdict row; enacted disposition recorded as immediate annotateOutcome — one shape.
DC-M5: outcome-annotation TRIGGERS + id persistence undesigned — hog ledger/ScanOutcome are in-memory
  last-16 (dies with process); completion id must ride run-state to the realcheck path; operator-reversal
  detection has no mechanism. FIX: hog id persists in durable kill-ledger row keyed ledgerKey, annotated
  from next scan tick; completion id persists in run-state file, annotated from realcheck path;
  operator-reversal detection explicitly OUT (named residual).
DC-M6: decisions↔outcomes JOIN locus — ledger asserted to gain a read over data it doesn't hold (outcomes
  in JSONL; readRedacted newest-first 1000-cap, no by-id/window query). FIX: outcomes ALSO land in small
  additive SQLite table (decision_outcomes: verdict_id, grade, evidence, ts) written by annotateOutcome
  chokepoint → /decision-quality = pure per-machine SQL join. (CONVERGES with scalability S1 substrate.)
DC-m1: seam field mapping for required DecisionRowInput fields (reason/floor/fallbackRung on LLM rows;
  raw-response head length — pin table, fallbackRung:'llm', head 500 chars).
DC-m2: error/shed-path provenance rule unstated (decision:'<error>' row vs success-only — state choice).
DC-m3: /decision-quality dark posture + contract unpinned — route 503s unless provenance.uniformSeam
  resolves live; params/shape frozen at graduation.
DC-m4: dry-run log content must be metadata-only (never contextFull into server.log — posture violation).
Convention-answered (no findings): coverage file format (llmBenchCoverage.ts precedent), job manifest
  (correction-analyzer.md), id format, existing 2 deterministic callsites unchanged, Bearer auth, dryRun flip.

### Internal — ADVERSARIAL (landed, 8 MATERIAL + 3 minor)
ADV-M1: correlation id has no schema home + no return path (= DC-M1/S3; adds: hog loop never sees id).
ADV-M2: failure-swap writes N DECISION rows for one decision (each attempt sees options.provenance and
  completes) — flaky framework inflates row count, errored rows forever-unknown dilute wrong-rate,
  ambiguous annotate target. FIX: exactly-one decision row per correlation id — write on decision
  SETTLEMENT at the router (only layer seeing one call), attempt detail stays in metric rows.
ADV-M3: annotateOutcome is unauthenticated append-many — no existence/component check, no dedupe, no
  FD3 enum validation at write, unlimited re-annotation; self-grading free (hog grades own kills). FIX:
  (a) gradedBy (component+rung) on every outcome row; (b) precedence deterministic>recurrence>LLM>self-
  report (self never overrides independent); (c) idempotency key correlationId×gradedBy (upsert);
  (d) read counts each decision ONCE under winning grade.
ADV-M4: no evidence-quality bounds — commandHash respawn coincidence (operator reopens VS Code →
  identical hash → kill graded wrong; 20 restarts → 40% wrong → operator de-tunes a correct gate). FIX:
  precise per-rule evidence predicates (same hash AND same owner AND bounded window AND owner-alive-at-
  kill else unknown); every grade row carries evidence-rule id; grade-by-rule breakdown on route.
ADV-M5: grade-injection — argv/user text in rows steers the LLM interpreter rung (process named
  "SYSTEM NOTE: grade wrong…"); grades feed operator decisions = self-reinforcing loop. FIX: untrusted-
  data envelope (FENCE) mandate; grading component registered injection-EXPOSED in static map; LLM-rung
  grades marked as such on read surface.
ADV-M6: retention mismatch (JP 14d vs feature_metrics 30d) — outcomes-known ratio structurally collapses
  with age; trend reads as grading decay; 3 orphan classes (dangling verdict_id; late evidence annotating
  deleted row — no existence check; sampled-out decisions' outcomes). FIX: durable grades table beside
  feature_metrics (correlationId, feature, decisionPoint, grade, gradedBy, ruleId, ts) ≥30d retention;
  read distinguishes expired from unknown. (CONVERGES with S1/DC-M6 substrate + codex6.)
ADV-M7: 'wired' self-declared, never verified — declared-wired component that never passes
  options.provenance is CI-green forever (G5 defeated by false declaration). FIX: census test statically
  requires provenance: reference in declaring component's source; /decision-quality flags wired-but-silent
  (≥N llm calls in-window, zero provenance rows).
ADV-M8: dual-writer verdict_id + caller-injectable correlation id — classifyVerdict.verdictId (documented,
  breaker honors it) collides with router mint; options-borne id can be pre-set/spoofed to pollute chains;
  jp time36+seq id shape collides across instances. FIX: router mints UNCONDITIONALLY (overwrites inbound);
  breaker-floor rows carry mintedBy:'breaker'; caller verdictId → separate callerRef or documented-to-lose;
  collision-resistant ids (random component). (SUPERSET of DC-M2.)
ADV-m1: pending:<ACT> unbounded/unvalidated — format-validate ACT ref; say "pinned shrink-only ≥40-char" explicitly.
ADV-m2: mixed-sampling distributions misleading (arbiter always vs floor 0.1) — expose per-point sampling
  rate + row-class counts.
ADV-m3: grading read path — pin which view (redacted vs contextFull) the grader consumes + bounds (interacts M5).

### Internal — INTEGRATION (landed, 8 MATERIAL + 3 minor)
INT-A1: JP log constructed ONLY in mesh block (= DC-M3, with brace-trace evidence server.ts:19005/21622);
  on single-machine dev agent the seam has nothing to write to and /decision-quality 503s the whole soak.
  FIX: construction moves out of mesh block (unconditional or gated on uniformSeam); route text updated;
  named deliverable (edits shared boot path).
INT-A2: outcome annotation STRANDS on topic transfer — decision row on machine A, run moves, ground truth
  lands on B → orphan outcome row; per-machine join reports unknown forever; pool summaries can't repair
  pairing. FIX (pick one, state it): (a) honest-degradation + orphanOutcomes counter on route; (b) outcome
  routing — correlation id carries machineId prefix, annotator POSTs to owning machine, offline-degrades
  to (a).
INT-A3: "participates in machine-coherence guard like sibling flags (no special handling)" is FACTUALLY
  WRONG — manifest is closed enumerated list (COHERENCE_CRITICAL_FLAGS) + EXCLUSIONS-with-reason registry.
  FIX: replace sentence; deliverable = EXCLUSIONS row for provenance.uniformSeam.enabled with stated reason.
INT-A4: PASS — operator-ratified-exception citation verified TRUE (registry:522 pins machine-local-full/
  HTTP-redacted; SHA resolvable; lint contract satisfied). Minor polish: cite registry heading + SHA.
INT-A5 minor: pool merge semantics — pin machine-tagged rows per decision-point (per-machine framework
  routing means genuine per-machine skew); inherit 8KB clamp + pool.failed hygiene.
INT-B1: ZERO migration-parity/agent-awareness coverage. FIX: new section — generateClaudeMd capability
  section (+ proactive trigger), migrateClaudeMd sniffed twin, migrateConfig explicit NO-OP-BY-DESIGN
  (omit key — seeded false would pin the dev gate off, the #1001 trap), installBuiltinJobs covers both
  paths for the job (true sentence to include).
INT-C1: rollback + retention semantics — pin: (1) minting/stamping gated-or-not (pick, say why);
  (2) join-miss = 'unknown provenance', never error, joinMiss count on route; (3) seam-off stops new rows
  only, old rows age out, no purge.
INT-D1: dashboard follow-up is untracked prose (Close the Loop). FIX: evolution action / bind ACT-1194 +
  tracked marker on the spec line.
INT-E2: FD6 posture conflates registries — seam belongs in DEV_GATED_FEATURES (omitted key →
  resolveDevAgentGate → LIVE-on-dev/DARK-fleet), NOT DARK_GATE_EXCLUSIONS; dryRun defaults TRUE even on
  dev until deliberate flip. Exact FD6 language provided; deliverable = DEV_GATED_FEATURES entry with
  safe-to-run-live justification.
INT-E3: Testing section required (tier plan enumerated — unit swap-id threading, integration route+pool,
  E2E feature-alive on production init path [would have caught A-1], wiring both-sides dev-gate test,
  semantic grade boundaries, ratchet fixture tests).
INT-minors: grading job body never messages (pin so FD5 can't erode at template time); registry-heading
  citation; pool hygiene (folded above).

### Internal — SECURITY (landed, 6 MATERIAL + 2 minor)
SEC-M1: raw LLM response head lands in UNSCRUBBED HTTP-served `decision` field (only context+reason are
  scrubbed; decision/optionsPresented/floor verbatim; readRedacted redacts by omitting contextFull only) —
  raw model output echoes prompt content (the judged material). FIX: served decision field carries ONLY
  classified/bounded verdict or 'unclassified'; raw head goes into context (scrubbed+clamped) or
  scrubString + ~300-char clamp before recordDecision.
SEC-M2: external-hog FULL ARGV rides contextRedacted (first 2000 chars of scrubbed context) onto HTTP/pool
  surface; scrub is credential-SHAPE only (sk-ant-*, ≥32-char base64url) — positional passwords/short
  keys/emails pass through. FIX: hog provenance context = identity+verdict fields only (commandHash/
  ledgerKey/classId, name, floor booleans, CPU numbers); raw argv EXCLUDED (hash it).
SEC-M3: FD3 free-form evidence notes HTTP-served, no clamp below 64KB row overflow. FIX: ≤~500-char clamp
  at annotate time + pointer/identifier content rule (never message bodies), or machine-local full +
  redacted summary.
SEC-M4: grading path unfenced — LLM interpreter reads attacker-influenceable rows; tier-1 job class runs
  toolAllowlist:"*" so echoed row text reaches a full-tool agent. Substrate already solves it
  (CompletionEvaluator instruction-inert fence; correction-analyzer provenance-weight pin) — spec carries
  none. FIX: FENCE mandate + enum-constrained parse → unknown on ambiguity; endpoint returns aggregates +
  clamped enveloped snippets; job template pins quoted-content-is-data. (= ADV-M5, converged resolution.)
SEC-M5: no content-discipline rule for message-carrying retrofits — census drives tone gate/response-review/
  MessageSentinel (context IS user message bodies) through the seam; arbiter bypass → rolling 14-day
  plaintext archive of every judged message + first-2000-chars over HTTP. FIX: generalize §5.3 transcript
  rule into §5.2 envelope discipline — message-content points store identity (hash/pointer + bounded head),
  never full body; or explicit operator ratification of archive posture.
SEC-M6: test plan absent; the redaction invariants ARE the security posture — semantic tests: no unscrubbed
  model output/argv served; contextFull never crosses readRedacted/pool; evidence clamped; route authed +
  503-dark + E2E alive.
SEC-m1: pool fan-out peer-URL guard — /judgment-provenance attaches Bearer WITHOUT
  isPeerUrlAllowedForCredentials (unlike /guards) and spreads arbitrary peer fields ({...row}); pin guard +
  field allowlist for merged summaries (+ retrofit routes.ts:15031 in this build).
SEC-m2: seam consumes and STRIPS options.provenance before delegating to inner.evaluate (defense-in-depth
  vs future adapter logging).
Verified-clean: route auth automatic (middleware exemption-list pattern); correlation id itself not a leak
  channel; no rotation races.

### Internal — LESSONS-AWARE (landed, 8 MATERIAL + 4 minor)
LES-M1: parent standard's bench-battery clause SILENTLY DROPPED — "graded real cases feeding its bench
  battery" (registry:523) has no design/goal/tracked deferral (ACT-1195 is prompt-parity, different thing).
  FIX: minimal graded-case→battery export OR explicit tracked deferral naming the clause.
LES-M2: FD4 blanket arbiter:true at retrofit scale — MEASURED 4,098 llm calls/24h (3,641 CoherenceReviewer);
  sampling knob inert, no byte/day budget; worst ~260MB/day. FIX: volumeClass per decision point +
  daily budget + loud shed counter. (= S2.)
LES-M3: §5.5 JOIN inherits EvolutionManager doom-loop shape — readRedacted whole-file sync parse on event
  loop; verdict_id unindexed; THREE consumers (route, pool fan-out, job). FIX: durable grade rollup at
  annotation time (spend_token_rollup prior art SAME FILE :164-179 — "pre-aggregate immutable fact"),
  index, cached snapshot; never per-request JSONL scans. (= S1/DC-M6/ADV-M6.)
LES-M4: 14-day memory horizon can't answer the operator's actual question ("over time" = weeks-months);
  grades die with provenance retention. FIX: content-free durable rollup (decisionPoint × day × counts)
  surviving raw expiry. (Foundation precedent: spend_token_rollup "long history decoupled from short
  raw-row horizon".)
LES-M5: internal contradiction "no new schema" vs the join the spec stands on — DecisionRowInput has no
  correlationId, no promptId (spec lists promptId as an existing field — it isn't). FIX: name the additive
  fields as deliberate schema extensions.
LES-M6: census exempt/pending will rot into pinned-backlog (WIRING_EXCLUSIONS lesson — 13 components sat
  until operator forced #1319). FIX: (a) CLOSED exempt taxonomy (deterministic-only | no-decision-content |
  operator-ratified:<ref>); (b) Close-the-Loop cadence — /decision-quality reports census debt counts.
LES-M7: retrofit changes WHAT flows through HTTP-served contextRedacted — conversation content enters a
  surface ratified for admission metadata (foundation's own honesty pin :30-32: credential-shape-only
  scrub is justified BY machine-locality; contextRedacted is NOT machine-local). FIX: content classes in
  census; content-bearing contexts enter as identity/hash/bounded-features (or redacted view omits
  contextRedacted for such rows). (= SEC-M5 converged.)
LES-M8: no test plan + two lessons unengaged: (a) stamping verdict_id on every row breaks pinned tests
  (CircuitBreaking-feature-metrics-tap.test.ts asserts NULL world) — sweep ALL tests/ before push;
  (b) day-files/retention/windows are wall-clock-coupled — injected clocks mandate (both foundations
  expose now() seams).
LES-m1: grading-job convergence semantics — graded once per new evidence; unknown re-checkable w/ backoff
  or terminal give-up; per-tick deterministic work bounded.
LES-m2: durable id carry between decision and late ground truth (survives restart) — name where it persists.
LES-m3: seam write CPU budget sentence (scrub + ≤3 stringify passes ≤64KB).
LES-m4: POSITIVE — all spec anchors verified true; recon quality high.
CONFORMANCE FLAG 1 RESOLVED-STALE empirically: worktree parser extracts 74 articles incl. the parent
  standard; checker ran against pre-#1436 dist. No spec change; record in report.
FEEDBACK MEMORY: no feedback_*.md files exist (stated honestly; session-memory lessons engaged instead).

## Round 2 (started 2026-07-11 ~18:47 PDT)
- Spec v2 committed fbc3c06ef; body hash 954a2cb30e10aa5699b8ace8af202b05d30e38ac43c5d17df6e41b090955a711
- Conformance gate: ran — 1 flag (down from 3): Operator-Surface Quality (API-only route for an operator
  decision surface; FD13 tracks dashboard deferral — handed to INT/LES reviewers for a firm judgment).
  Round-1 flags cleared: traceability (stale, resolved), maturation (FD6 precise), testing (section added).
- Externals: codex gpt-5.5 RAN ok — MINOR ISSUES (was SERIOUS r1); gemini RAN ok — MINOR ISSUES.

### Codex r2 (5 points + 1 caveat)
CX2-1: decision boundary for multi-call judges (one human-visible decision spanning multiple evaluate()
  calls — cascaded classifiers, decomposed prompts). FIX: define boundary = one router.evaluate() call =
  one decision row; composing callsites DECLARE one-decision-vs-linked-rows in census entry.
CX2-2: rollup late-arrival/regrade mutation rules unstated (regrades, precedence upgrades, expiration,
  orphan resolution, retention pruning). FIX: specify rollup mutation semantics. MATERIAL.
CX2-3: right/wrong may grade the pipeline, not the LLM recommendation (floor-veto/governor-hold makes
  outcome uninformative about classifier). FIX: clarify grades attribute to the LLM VERDICT; enacted
  disposition is recorded fact, not graded object; outcome rules must condition on enactment.
CX2-4: grep-wired is weak — dead code satisfies it. FIX: typed registration (census imports decision-point
  ids from single registry) + integration tests for first customers; runtime flag stays.
CX2-5: content-class envelopes operationally subjective. FIX: per-class envelope BUILDERS/validators so
  callsites can't hand-roll.
CX2-6: caveat — JPL context truncated in reviewer input (disclosure only).

### Gemini r2 (3 points)
GM2-1: glossary/exec summary (minor — ELI16 is the accessibility surface; add brief glossary).
GM2-2: ACT-1199 priority — sustained orphan blind spot on multi-machine fleets (advisory; operator call;
  record as noted dissent/priority nudge, orphanOutcomes visibility is the honest mitigant this build).
GM2-3: content-bearing truncation may drop the salient "why" — lean on code-derived FEATURE EXTRACTION
  (already in §5.2) over raw heads for high-stakes points; clarify.

### R2 Internal — SECURITY (landed: all 8 r1 resolutions GENUINE; 3 new MATERIAL, each one-clause)
SEC2-M1: breaker floor behavior on an INBOUND id unspecified (router never wraps recordMetric; direct
  caller-supplied id flows unexamined into verdict_id → chain pollution). FIX clause: breaker treats ANY
  inbound correlation id as absent unless it carries the router's per-call mint marker; else re-mint
  locally + mintedBy:'breaker'. (Honest scope: guards the documented/accidental path, not hostile
  in-process code.)
SEC2-M2: options.provenance strip only at router; breaker spreads options verbatim into inner adapters on
  the bypass path (CBIP.ts:215-226). FIX clause: strip ALSO enforced at the funnel wrapper; unit test
  extended to direct-provider path.
SEC2-M3: optionsPresented is caller-authored, served UNSCRUBBED (readRedacted only omits contextFull);
  verdict_class copied into "content-free" table — runtime data interpolated into option labels reopens
  the raw-content channel. FIX clause: optionsPresented entries + verdict_class MUST be static code-authored
  enum-like labels, charset/length-clamped at settlement write (^[a-zA-Z0-9_-]{1,64}$; violation →
  'unclassified' + counted) + unit test.
Non-material notes: gradedBy rung is in-process trust (optional hardening: registered rule→rung table —
  fold as one sentence since ADV r2 likely hits it too); explicit "evidence_note not in /decision-quality
  payload" sentence nice-to-have (fold); grade-pass abuse surface minimal; machineId prefix no new exposure.

### R2 Internal — SCALABILITY (landed: all 4 r1 resolutions GENUINE; 4 new MATERIAL + 4 minor)
SCAL2-M1: settled-attempt usage/model capture semantics unspecified — naive last-write-wins is WRONG:
  (a) onUsage fires INCLUDING calls that subsequently reject (failed primary's usage attributed to a later
  swap attempt); (b) withSwapTimeout-abandoned attempts fire late callbacks that overwrite post-settlement.
  FIX clause: per-ATTEMPT capture scoping (fresh wrapper closures per attempt, composed over caller
  callbacks + the nonGatingSwap compose at IR.ts:1263-1272); only the returned attempt contributes;
  post-settlement callbacks discarded.
SCAL2-M2: rollup aggregates MUTABLE facts (spend prior art is increment-only immutable) — supersede,
  precedence flips, unknown→right, and `expired` has NO specified writer; no crash repair (spend has
  reconcileSpendRollup(30)). FIX: recompute-affected-(decision_point,day)-bucket from
  decision_quality⋈decision_outcomes on each annotate (bounded, self-healing) + bounded boot/periodic
  reconcile; pin the expired writer (grading job's terminal give-up writes it — pick and state).
SCAL2-M3: "async-buffered off the decision path" is false for the SQLite half (better-sqlite3 is sync).
  FIX sentence: async-buffered scopes to the JSONL row; decision_quality insert = sync WAL insert,
  isolated try/catch, never throws into decision path, ≤1 per settled decision (record() prior art).
SCAL2-M4 (low): onCorrelationId fires unconditionally but sampled/budget classes DROP the decision row →
  outcome rows with no parent, grading budget wasted on undecidable ids. FIX clause: onCorrelationId fires
  only for ADMITTED (written) decisions (pick this — simplest contract), or a named honest counter +
  cursor skip.
SCAL2-m1: cursor = keyset pagination ORDER BY (ts, correlation_id) compound boundary (same-ms bursts skip
  at page boundary forever with ts-only). FOLD.
SCAL2-m2: wired-but-silent is per-feature counts vs per-point rows — multi-point component masks a silent
  sibling; honesty parenthetical. FOLD.
SCAL2-m3: quality-table prune path unnamed — pin to PRUNE_BATCH/pruneOlderThan prior art. FOLD.
SCAL2-m4: name the indexes ((decision_point, ts) on decision_quality; ts-reachable path on outcomes). FOLD.
Extra verifications: rollup writers fully serialized (one process, one better-sqlite3 conn, WAL — no
  contention language needed); pool fan-out matches sibling; FD9 + first-customer + SEC-m1 premises all
  confirmed against code; CompletionEvaluator path is src/core/ (cosmetic cite fix).

### R2 Internal — DECISION-COMPLETENESS (landed: 5.5/6 r1 gaps genuinely closed; 3 MATERIAL + 5 minor)
DC2-M1: hog id carrier is a FALSE CODE ANCHOR — KillLedgerState is IN-MEMORY (no load/save; "persists
  across ticks" not restarts), retention hardcoded 1h < 6h evidence window, and leave-alive writes NO
  ledger record (recordKill fires only on kill) yet leave-recurrence grading needs the leave's id.
  FIX (frontload): new durable file <stateDir>/external-hog-decisions.json (atomic tmp+rename,
  fail-closed reads — ArmStore posture) per-ledgerKey { disposition, correlationId, atMs }, pruned at
  max(evidenceWindowMs, breakerWindowMs), hydrated at construction; in-memory P19 kill-breaker ledger
  untouched. Window-close (*-right-v1) grading in the grading job reading THIS store; positive-evidence
  grading in next scan tick. Also: evidenceWindowHours tunable must derive the carrier retention.
DC2-M2: rollup bucket attribution + expiry lifecycle unstated/self-contradictory — (a) late outcome day
  bucket? (b) supersede must decrement prior bucket (read superseded row); (c) FD3 says expired is
  READ-side yet rollup stores expired counts nothing can write; §5.4.6 "final unknown" vs §5.5 "expired" =
  two labels one event. FIX: bucket = DECISION's UTC day (spend convention) looked up from
  decision_quality (90d ≥ any late evidence); upsert reads prior winning grade, decrement/increment;
  DROP expired from rollup columns (derived at read: decisions − Σgrades for buckets older than raw
  retention, plus joinMiss); rename §5.4.6 terminal state to `expired` (kill "final unknown").
  (CONVERGES with SCAL2-M2 recompute-bucket + reconcile.)
DC2-M3: onCorrelationId firing point — fire at MINT (router entry, before first attempt), synchronously,
  exactly once, INCLUDING calls that subsequently throw; never after promise settles. (Errored settlement
  = gradeable row; hog floor-veto-on-classifier-throw is the disposition most worth grading.)
  RECONCILIATION with SCAL2-M4: decision_quality row (content-free ~200B) is written for EVERY enrolled
  settled decision REGARDLESS of volume class; volume class governs the provenance JSONL row ONLY
  (droppedByBudget counts JSONL drops). → outcomes always have parents; counts complete; valve still
  bounds the expensive part. 4k/day × 200B ≈ 800KB/day, trivial.
DC2-m4: ledger owns all 3 tables (SCHEMA array); recordDecision/upsertOutcome surface injected into
  router seam + JPL alongside recorder-singleton pattern. FOLD.
DC2-m5: wiredSilentMinCalls default 20, in provenance.quality keys. FOLD.
DC2-m6: budget day = UTC calendar day; enforce via indexed COUNT since UTC-day start (restart-safe). FOLD.
DC2-m7: grade-pass shape pinned iterable-while-dark too; body {}, response { graded, byRule,
  cursorAdvancedTo }. FOLD.
DC2-m8: ruleIds IMMUTABLE; predicate change bumps version. FOLD.
Cheap-tag contests: FD6 knobs CLEARED (with the evidenceWindow↔carrier-retention carve-out → DC2-M1);
  GET route shape CLEARED; machineId prefix CLEARED (spec already conditions it).
Money: zero-LLM-spend-this-build verified stated ×3 + job enabled:false.

## Round 2 FOLD → v3 (commit follows fbc3c06ef; body hash c50ff54cfc16e7dd26fe42edd2dbc3354d88fd6741ab8683fd8163e043210c2e)
All 26 r2 materials + minors folded (see spec v3). Key: durable hog store; settlement=every exit;
per-attempt capture; rung registry + within-rung conservative; rollup mutation semantics; b-/d- prefix;
joinMiss split; kind:'llm' scoping; funnel strip; charset clamps; prune deliverables; attribution
columns; pending-ACT liveness + pinned; typed census + envelope builders; exempt-but-active; singleton.
NOT folded (advisory, recorded): GM2-2 ACT-1199 priority nudge (operator call — noted as dissent).

## Round 3 (started ~19:05 PDT)
- Conformance gate: ran — ZERO flags (3 → 1 → 0 across rounds).
- codex gpt-5.5 RAN ok — MINOR ISSUES, "no serious architectural blocker": 5 refinements to fold:
  CX3-1 verdict_id polymorphic column — pin kind-scoped queries via lint/test (or dedicated column; pick
    the lint — schema churn not warranted for a write-only column).
  CX3-2 evidence-strength classification on aggregates (deterministic-proof | negative-evidence |
    recurrence-proxy | self-report) so proof-like vs heuristic grades are distinguishable — maps onto the
    rule registry (add evidenceStrength per rule; route aggregates split by it).
  CX3-3 runtime coverage asserted by decision-point ID (decision_quality already carries it) — component
    key only locates metric-call counts; state the bridge honestly.
  CX3-4 bounded history per ledgerKey (oscillation cases lost by latest-slot) — clamp N=5 within window.
  CX3-5 graduation checklist with expected counters per phase (§5.7).
- gemini r3 + 6 internal r3 reviewers in flight.
- gemini r3: DEGRADED (timeout) — recorded honestly per-round; spec-level aggregate stays clean RAN
  (gemini succeeded r1+r2; codex succeeded r1+r2+r3).

### R3 Internal — SCALABILITY: PASS, 0 MATERIAL (all r2 fixes + minors verified landed w/ accurate
anchors; all v3 mechanisms bounded/indexed/off hot path). Non-material build notes: covering index
(decision_point, ts, correlation_id) refinement; ArmStore fail-closed-read anchor imprecision; reconcile
window "30d, mirroring spend" at build time.

### R3 Internal — SECURITY: 3 MATERIAL (one-to-two-clause each; all r2 fixes verified genuine)
SEC3-1: hog store is dashboard-SERVABLE + EDITABLE by default (fileRoutes serve-deny covers only
  state/judgment-provenance/; no .instar/ exclusion) — grading ground truth poisonable via /api/files
  edit; also gitignore/backup-exclusion parity unstated (agent home is a pushed repo — untracked file
  could sweep into a commit, contradicting machine-local posture). FIX: add store path to
  NEVER_SERVED_PREFIXES (serve-deny implies edit-deny via isNeverEditable) + state gitignore/backup
  parity + Testing serve-discipline cases.
SEC3-2: prompt_id caller-supplied, HTTP-served at 90d, ESCAPES the §5.2 clamp (clamp enumerates only
  optionsPresented + verdict_class; model/framework are code-derived, fine). FIX: extend clamp to
  promptId (violation → fixed marker + counted) + Testing list.
SEC3-3: mint marker as worded lands on the CALLER's options object (router does let evalOptions = options
  :1154; !cfg early return passes caller object verbatim :1172) — a reused shared options object replays
  a stale MARKED d- id through the breaker (its own leaked marker satisfies the rule) → accidental
  injection path reopened. FIX: mint + marker attach to a router-INTERNAL clone (caller object never
  mutated) AND/OR breaker consumes marker single-use; reused-options-object test case.
SEC3 note (route to fold): a d- UNENROLLED mint with no decision_quality parent reads as 'expired' under
  §5.7(2) wording though expiry can't explain it within 30d — refine the not-written population to
  include unenrolled d- mints (id prefix alone doesn't distinguish enrolled-but-pre-graduation vs
  unenrolled router callers; use absence-of-parent + census status).

### R3 Internal — INTEGRATION: 4 MATERIAL (all r2 folds + editorial folds + ~30 anchors verified genuine)
INT3-F1: pending-ACT LIVENESS cannot run in repo CI — evolution queue is per-agent runtime state
  (state/evolution/*.json), non-hermetic by construction; bench precedent is closed-union format+pinning
  only. FIX (honest mechanism split): CI verifies format + pinned shrink-only + ≥40-char reasons;
  LIVENESS moves route-side — the census-debt block on GET /decision-quality resolves each pending:<ACT>
  against the live queue and flags pending-ref-dead rows (observe-only, FD5-compatible); pinned/critical
  note retained at build time.
INT3-F2: hog store ROOT placement (.instar/external-hog-decisions.json) — .instar/ root files NOT
  gitignored (arm marker verified unignored; config.json tracked); churning file in a git-synced agent
  home; pids crossing machines would poison respawn predicate. FIX: place at
  <stateDir>/state/external-hog-decisions.json (rides existing .instar/state/ gitignore, same subdir as
  JP log). COMBINE with SEC3-1: ALSO add to NEVER_SERVED_PREFIXES (integrity — /api/files edit could
  rewrite grading ground truth) + Testing cases.
INT3-F3: reconcile has no named wiring point (spend prior art is BOOT-ONLY) + the 6h prune timer's
  construction gate (retentionDays>0 || routingSpendOn) excludes quality tables. FIX clause: quality
  prunes + periodic rollup reconcile ride the existing 6h timer; construction condition gains a quality
  arm.
INT3-F4: ruleId→rung registry home unnamed. FIX sentence: co-located with PROVENANCE_COVERAGE in
  src/data (core already imports src/data); imported by the annotate chokepoint + grading endpoint;
  ratchet fixtures pin its enum.

### R3 Internal — LESSONS-AWARE: 2 MATERIAL (all r2 folds + 4 parent-standard obligations verified genuine)
LES3-M1: enacted enum incomplete vs real disposition space (ExternalHogScanTick.ts:222-224 lumps:
  would-kill (watch-only — the ONLY disposition during the entire dev soak), deferred, aborted
  (kill-time re-confirm failed), sigterm-exited (effective kill); plus decider-unavailable settlement
  :173-178). Unrepresentable → fails write or mis-buckets into killed → grades a kill that never
  executed. FIX: extend enacted taxonomy to real outcome space; only killed|sigterm-exited enter
  kill-grading rules; would-kill/deferred/aborted/decider-unavailable age out unknown.
LES3-M2: pending-ACT liveness CI-resolvability asserted not designed (= INT3-F1, independent
  convergence): evolution queue is agent-runtime state; ACT ids machine-local by the system's own WS2.5
  design. FIX: split like `wired` — CI = format + pinned-shrink-only + reasons; liveness = agent-side
  runtime check surfaced as census debt on /decision-quality (pending-ref-dead flagged rows).
LES3 minors: m1 prune-timer creation condition (= INT3-F3, fold together); m2 InstallBuiltinJobs is
  src/scheduler/ (cite fix); m3 explicit at-rest clause for hog store (fold w/ SEC3-1/INT3-F2);
  m4 one-sentence acknowledgment of the identity+features reading vs the parent rule's "full context"
  letter (deliberate, converged r2 — say so in-spec).

### R3 Internal — ADVERSARIAL: 5 MATERIAL (all 8 r2 folds GENUINE; 25+ anchors accurate; revived after
nudge — stall recorded)
ADV3-1: respawn-wrong predicate — ownerTuple unpopulatable in the DOMINANT orphan-kill case (parent
  absent from proc tree = no startTime exists) or records the impostor's tuple (pid-reuse case). FIX:
  record the KILLED PROCESS's OWN (pid, startTime) in the store; wrong ONLY IF currently-alive process
  at recorded parentPid has startTime ≤ killed child's recorded startTime (un-orderable → unknown).
  Start times can't be forged old — spoof-proof both directions.
ADV3-2: latest-slot EVICTS the decision it should grade (mainline respawn = new same-ledgerKey decision;
  intra-tick ordering unpinned; same-commandHash flood evicts pending kills). FIX: grade-on-supersede
  (evaluate prior slot's predicates BEFORE overwrite) + retain in-window KILL decisions alongside latest
  slot.
ADV3-3: pending-ACT liveness (= INT3-F1/LES3-M2, third independent convergence) + define alive =
  registered AND non-terminal + pending-ref re-pointing is a reviewed baseline change (shrink-only
  covers count, not identity).
ADV3-4: leave-recurrence gradeable on FABRICATED evidence — ledgerKey is a hash of attacker-controlled
  argv; any same-uid process runs a sustained lookalike → correct spare grades wrong (same-uid external
  processes are the sentinel's literal subject, excluded nowhere). FIX: recurrence = the SAME process
  (candidate signature pid+startTime, already computed ScanTick:122/150) re-flagging; different process
  same commandHash → unknown.
ADV3-5: sustained-right overclaims its sensor (respawn visibility = sustained-CPU candidates only; quiet
  respawns invisible → optimistic bias unstated). FIX: honesty clause — predicate = "no same-commandHash
  CANDIDATE re-flagged within window" (named bound); optional cheap window-close proc-table probe.
ADV3 non-material to fold as wording: settlement illustrative list gains RouterFailClosedError rethrow +
  fallback:'none' throw; not-written wording names unenrolled d- mints too; decider-unavailable/over-cap
  settle honestly unknown (LES3-M1 covers the enum extension); optional runtime decisionPoint∈census
  validation + count.

### R3 Internal — DECISION-COMPLETENESS ×2 (stall + revival recorded honestly)
DC-ORIGINAL (revived after nudge, full charge): 2 MATERIAL + 6 minor. DC-RERUN (fresh): PASS + 3 minor.
Both agree on the minors; original's materials converge with ADV3-2.
DC3-M1 (= ADV3-2): grade-on-supersede ordering — the supersede event IS the positive-evidence event for
  leave-recurrence; within-tick order unpinned → rule structurally never fires in its intended case.
  FIX: evidence rules applied against the OUTGOING record BEFORE slot replacement.
DC3-M2: window-close grading vs prune RACE — entry becomes gradeable at exactly the age it becomes
  prunable; grading job default cron unstated → race unbounded on paper; derivation clause doesn't
  deliver its guarantee. FIX: hog-store retention = evidenceWindowMs + gradingSlackMs (slack ≥ 2× job
  cadence; name default cron hourly).
DC3 minors (both agents): grading cursor + recheck-backoff state home (4th small table
  decision_grading_cursor + ADDED_COLUMNS recheck fields; cursorAdvancedTo = map by decisionPoint);
  machineId8 source (pool/mesh self id, first 8 chars, injected at AgentServer construction; absent →
  segment omitted); periodic reconcile host = the 6h timer (spend prior art is boot-only); dryRun scope
  ambiguous (pin: suppresses BOTH JSONL and SQLite writes; metadata-only logs); ruleId registry home =
  census module; evidenceWindowHours changes -v1 semantics without version bump (pin window into rule
  registration; outcome rows record effective windowMs; window change mints -v2); cite fixes
  (src/scheduler/InstallBuiltinJobs, src/monitoring/FeatureMetricsLedger).
R3 TOTALS: SEC 3 + SCAL 0 + ADV 5 + INT 4 + LES 2 + DC 2 = 16 MATERIAL (+ codex 5 refinements; gemini
  timeout). All narrow pins; zero structural rework; every r2 fold verified genuine by every reviewer.

## Round 4 (started ~19:47 PDT; confirmation round on v4, body hash afbbec94761fc1a74ea9af6dd6afeeaee0cc6143e78936289383a4bb23934b0f)
- Conformance gate: 1 flag — the SAME stale-checker traceability artifact as r1 (deployed dist predates
  #1436; empirically resolved-stale in r1 via worktree parser extracting 74 articles incl. the standard;
  the LLM checker is non-deterministic on it — flagged r1+r4, clean r2+r3). Recorded per-round honestly;
  no spec change.
- codex r4: RAN ok — MINOR ISSUES. Dispositions:
  CX4-1 dedicated correlation_id column vs polymorphic verdict_id — re-argues a DOCUMENTED accepted
    tradeoff (§5.1.3 pins lint enforcement); fold ONE sentence documenting why schema churn was rejected
    (write-only column, zero readers, lint-enforced kind-scope). Non-material.
  CX4-2 strength-first primary aggregates — route already exposes strength breakdowns, never conflates;
    fold ONE presentation sentence (default aggregate view groups by strength first). Non-material.
  CX4-3 evidence-adapter interface — implementation shape; the rule registry IS the adapter seam. Note.
  CX4-4 census bureaucracy / wired vs gradeable — outcomes-known ratio + wired-but-silent already expose
    thin evidence; recorded as dissent. Non-material.
  CX4-5 dryRun suppresses durable writes limits validation — genuine tension, already staged: graduation
    phase 3 (dryRun:false on dev) is where substrate validation happens; fold ONE honesty clause. Non-material.
  CX4-6 context caveat — disclosure.
- gemini r4: DEGRADED (timeout) — same as r3; consistent with the known deprioritized individual
  gemini-cli service (zombie-alive since June 18). Per-round honest record: gemini ok r1+r2, timeout
  r3+r4; codex ok all 4 rounds → spec-level cross-model flag = clean RAN (codex-cli:gpt-5.5).
- R4 SCALABILITY: PASS, 0 material (grade-on-supersede O(1)-ish; slot retention bounded; 4th table/
  backoff/reconcile/checklist all cheap; clone+uuid unmeasurable; all r3 properties intact). Immaterial
  notes for build: "in-window kill" = ENACTED-kill reading intended (state at build); shallow clone
  suffices; next_recheck_ts index optional; census-debt liveness read is read-side bounded.
- R4 DECISION-COMPLETENESS: PASS — "CONVERGED at round 4". 7/7 r3 folds line-verified; 7 candidates
  contested-then-cleared (orphan rollup attribution = NULL bucket coherent; hog store IS written during
  dryRun — coherent with soak sentence; id grammar disambiguates by segment count; backoff params
  builder-tunable under P19 bound; wiredSilent window = ?sinceHours convention; grade-pass dark serving
  covered; double-grading converges via upsert key). 0 remaining cheap tags; FD count 13.
- R4 ADVERSARIAL: 1 MATERIAL. ADV4-1: respawn-wrong predicate requires the recorded parent pid, but the
  schema says ownerTuple "recorded as absent" in the parent-absent case — yet parseParentPid SUCCEEDED
  for every permitted kill (FactBuilder:74 vetoes null-parse), so the PID is always in hand; only the
  START-TIME is where-derivable. Two bad implementer exits (rule dead for dominant class, or substitute
  respawn's pid = spoofable). FIX (one clause, three touch points §5.2/§5.3/§5.4.5): member-wise
  recording — ownerTuple.parentPid ALWAYS recorded on kill decisions; parentStartTime where-derivable;
  fix the "no ownerTuple could be recorded" parenthetical. Non-material attacks that did NOT land:
  lstart tie behavior correct (ties non-fabricable; DST noise accepted, floor has identical exposure);
  slot bounds; marker per-attempt-object consumption (tests jointly force correct reading);
  strength classes registry-fixed.
- R4 SECURITY: 1 MATERIAL. SEC4-1: NEVER_SERVED_PREFIXES is projectDir-rooted; the store lives at
  .instar/state/... (stateDir = projectDir/.instar) — a 'state/...' literal is a production NO-OP, and
  the EXISTING 'state/judgment-provenance/' entry is itself misrooted (empirically verified:
  isNeverServed('.instar/state/judgment-provenance/x') → false; the unit test constructs a layout
  production never produces — that's how it went green). JP contextFull rows are exposed to the file
  editor TODAY. FIX (one clause §5.3 + one §Testing): pin the projectDir-relative literal
  '.instar/state/external-hog-decisions.json' + dual-root/fix the existing JP entry in the same PR +
  pin the test to the production layout (store under <projectDir>/.instar/state/). Note honestly:
  BackupManager prefixes are stateDir-relative, fileRoutes projectDir-relative — the root divergence is
  the trap. (ALSO: this is a live pre-existing defect worth an issue/observe entry regardless of the spec.)
  Folds 2+3 verified genuine; targetTuple/checklist/strength/pool all clean.
- R4 INTEGRATION + LESSONS-AWARE: NO VERDICT — both reviewer sessions killed by the 19:50 PDT context-
  window respawn before filing. NOT counted as passes; both perspectives re-run in round 5.
- Live defect durably tracked: ACT-1200 (NEVER_SERVED_PREFIXES misrooted; JP contextFull servable+
  editable via /api/files — fix rides this build's PR per SEC4-1 fold).

## Round 4 FOLD → v5 (commit follows c81ad2d1e)
Round 4 verdict: NOT clean — 2 MATERIAL (ADV4-1, SEC4-1) + codex 3 one-sentence folds → round 5 is a
fresh full confirmation round, not a stamp.
Folded: ADV4-1 member-wise ownerTuple (parentPid ALWAYS on kills — FactBuilder:74 vetoes null-parse;
parentStartTime where-derivable; §5.3 schema + §5.4.5 parenthetical fixed — both bad implementer exits
closed); SEC4-1 NEVER_SERVED projectDir-relative literal '.instar/state/external-hog-decisions.json'
pinned + existing JP entry named as live production NO-OP fixed in same PR (§5.2 honesty note + §5.3) +
Testing pins the PRODUCTION layout; CX4-1 dedicated-column rejection rationale sentence (§5.1.3);
CX4-2 default aggregate view groups by evidence strength FIRST (§5.5); CX4-5 dryRun-suppresses-writes
staging honesty clause (§5.7 graduation). Non-material notes recorded: CX4-3 (registry IS the adapter
seam), CX4-4 (dissent recorded), ADV4 non-landed attacks, SCAL4 build notes (in-window kill =
ENACTED-kill reading; shallow clone suffices).

## Round 5 (confirmation round on v5)
- All six internal perspectives re-run fresh (INT + LES never filed r4 — their r5 read covers both
  their r4 confirmation duty and any new findings); codex + gemini + conformance gate per protocol.
- v5 commit 324ebe802; spec file sha256 6fc2e5bf80a06e638d9443f1c577ac66037913d7970b1fea46fcc77db9e6c34b
- Conformance gate: ran — 2 flags, BOTH known artifacts: (1) Constitutional Traceability = the same
  stale-checker false positive as r1/r4 (deployed dist reads 51 articles, predates #1436; worktree
  registry carries the parent standard — empirically resolved-stale in r1); (2) Operator-Surface
  Quality = disposed r2 via FD13 + ACT-1197 dashboard follow-up (handed to INT r5 to confirm the
  disposition held). registryCanary ok.
- codex r5: RAN ok (gpt-5.5) — MINOR ISSUES, no serious blocker. Dispositions:
  CX5-1 verdict_id polymorphic column — re-argues the documented accepted tradeoff (CX4-1 rationale
    sentence already in §5.1.3; kind-scope lint pinned). Continued dissent, recorded. Non-material.
  CX5-2 minimum-sample honesty on aggregates — GENUINE cheap refinement: fold ONE sentence (§5.5
    default view carries an explicit insufficient-evidence marker below a minimum sample threshold,
    default n<20, rather than implying actionable rates from tiny samples). Editorial fold.
  CX5-3 evidence adapters as versioned plugins — the versioned-immutable ruleId registry IS the
    adapter seam (CX4-3 disposition). Non-material.
  CX5-4 integration tests exercising real call paths per wired point — already required by §Testing
    (CX2-4 fold: typed registration + first-customer integration tests). Non-material repeat.
  CX5-5 dryRun shadow-write mode — re-argues the CX4-5 deliberate-staging disposition (§5.7 honesty
    clause). Non-material, dissent recorded.
  CX5-6 context caveat — disclosure only.
- gemini r5: DEGRADED (timeout) — 4th consecutive (known deprioritized service since June 18).
  Per-round honest record: gemini ok r1+r2, timeout r3+r4+r5; codex ok all 5 rounds → spec-level
  cross-model flag = clean RAN (codex-cli:gpt-5.5).
- Internal reviewers r5: in flight (all six).
- R5 SCALABILITY: PASS, 0 material, 0 minor. All four v5 folds verified genuine/no-regression
  (member-wise ownerTuple = two scalar fields in a rare-write pruned store; NEVER_SERVED = one literal
  in a per-request prefix check off the decision path; strength-first = one GROUP BY over indexed
  bounded reads; CX4-5 = prose). r4 build notes intact. Fresh code-grounded sweep clean (JPL async
  append verified :244-277; decision_quality sync WAL insert mirrors FeatureMetricsLedger.record;
  hog-store writes bounded by maxClassificationsPerScan; prunes ride 6h timer; route never scans
  JSONL; grading cursor-keyset 200/pass + P19 terminal expired). "Genuinely converged."
- R5 DECISION-COMPLETENESS: PASS, 0 material, 0 minor. All five v5 folds verified as adding NO new
  decision points. Buried-decision sweep clean; all defaults concrete; FD1-FD13 complete;
  Open questions empty; Decision points touched fully classified (5 invariant + 1 judgment-candidate
  with floor). Counts: cheap=2 (both cleared), contested-rejected=0, open-user-decisions=0.
  "CONVERGED (round-4 declaration re-affirmed on v5)."
- R5 SECURITY: PASS, 0 material, 2 MINOR (one-clause robustness pins for the editorial fold):
  SEC5-m1 onCorrelationId throw containment — router invokes the callback in try/catch (caught,
  counted, never propagates) + unit-test line (§5.1.4; sibling classifyVerdict contract documents
  try/catch, types.ts:1104-1110). SEC5-m2 hog-store backup-exclusion mechanism unnamed — JP log rides
  the unconditional NEVER_BACKUP_PATH_SEGMENTS 'judgment-provenance' segment (BackupManager.ts:88-90)
  while the hog store holds only by includeFiles allowlist-absence, defeatable by a user-added
  'state/' allowlist → name the mechanism (segment parity, or state allowlist-absence as deliberate)
  (§5.3). FOLD-VERIFICATION deep-grounded: SEC4-1 all three parts GENUINE (validatePath/isNeverServed
  fileRoutes.ts:140/104-109; stateDir=projectDir/.instar Config.ts:739; the live-defect claim
  ACCURATE — 'state/judgment-provenance/' startsWith-false vs production layout, default
  allowedPaths ['./'], no NEVER_EDITABLE .instar/state/ entry; existing unit test seeds the fake
  layout tests/unit/fileRoutes-never-served.test.ts:60-62); SEC3-1/2/3, SEC2-M1/2/3, full r1 set all
  INTACT with code anchors (incl. routes.ts:~15030 JP pool branch retrofit premise re-verified real).
  "From the security perspective this spec has converged."
- R5 ADVERSARIAL: 1 MATERIAL + 4 minor. ADV4-1 fold verified GENUINE with line-accurate code grounding
  (parseParentPid ExternalHogFactBuilder.ts:44; null-parse → ownerAppRunning:true :73-74; floor vetoes
  owner-app-running ExternalHogFloor.ts:152 ⇒ every permitted kill had a successful parse); ADV3-1..5
  all intact.
  ADV5-1 MATERIAL: census discovery is COMPONENT-keyed while declarations are per DECISION POINT — a
  second judgment added inside an already-declared component reusing the sibling's
  attribution.component key silently skips EVERY layer (CI clean via sibling's entry;
  wired-but-silent quiet via sibling's rows; decisionPoint∈census counter fires only on ENROLL) =
  G5's "no silent skips" defeated in a named case. Verified: llm-bench-coverage-ratchet.test.ts
  asserts over Object.keys(COMPONENT_CATEGORY). FIX (one clause + one test line): state the honest
  bound (unenrolled same-key new point is caught at review, not the ratchet) + pin the 1:1 convention
  as a census-test assertion (each wired point's component key UNIQUE across census entries) so
  same-key reuse becomes lint-visible at declare/enroll time.
  ADV5-m1: ruleId→rung registry rows carry the OWNING component; annotate chokepoint rejects
  gradedBy.component ≠ registered owner (closes the last trusted label in §5.4).
  ADV5-m2: tighten "parentPid ALWAYS on kill decisions" → "on ENACTED kills (killed|sigterm-exited —
  equivalently every floorPermitted kill)" so a floor-vetoed kill VERDICT row (null-parse veto, no
  parentPid) can't fail a hard store-write assert.
  ADV5-m3: exempt census entries pinned shrink-only too (bench precedent pins BOTH baselines; spec
  pins only pending; no-decision-content is the soft spot).
  ADV5-m4: grade-pass fairness across per-point cursors (future high-volume point can starve siblings
  until windows prune) — per-point sub-budget clause or honesty note; unreachable this build.
  Non-landed attacks recorded: commandHash-collision fabrication, distinct-hash store flood,
  impostor parentStartTime in pid-reuse (non-load-bearing), stale-marker replay, legacy row-id path,
  run-state id tampering (pre-existing trust boundary).
- R5 INTEGRATION: PASS, 0 material, 3 minor. ALL r3 folds (INT3-F1..F4) + ALL r4 folds verified
  genuine with code grounding; SEC4-1 live-defect claim independently REPLICATED (matcher replay:
  '.instar/state/judgment-provenance/x.jsonl' → false; BackupManager stateDir-relative vs fileRoutes
  projectDir-relative root divergence corroborated). Standard A both directions clean
  (operator-ratified-exception ref verified: registry:522 heading + 965a3602c resolvable); Standard B
  not triggered; migration parity mechanism-verified; FD8 callerRef relocation breaks no production
  caller (MessageSentinel.ts:711-714, CommitmentSentinel.ts:339-344 return {acted} only);
  Operator-Surface Quality disposition NOT eroded (do not re-flag).
  INT5-m1 (= SEC5-m2, converged): hog store backup exclusion must be an ACTIVE
  REMEDIATION_EXCLUDED_PATH_PREFIXES entry (BackupManager.ts:89), not allowlist-absence.
  INT5-m2: CapabilityIndex.ts:125 /judgment-provenance text hardcodes the 503 cause FD9 removes —
  update in same PR (Agent Awareness Standard).
  INT5-m3: cosmetic anchor drift (migrateBuiltinJobs :3707; prune timer :1457-1464; !cfg :1162) —
  re-ground at build.
- R5 LESSONS-AWARE: PASS, 0 material, 0 minor — CLEAN CONFIRMATION. All r3 folds (LES3-M1/M2 +
  m1-m4) + all r4 folds verified genuine with line-accurate grounding (enacted enum matches
  ExternalHogKillFunnel.ts:25-29 + ScanTick alert-only branches exactly; over-cap = no LLM call = no
  row, consistent). Both conformance flags disposed empirically (registry:522/523 carries the parent
  standard + bench-battery clause — FD12 citation exact; Operator-Surface FD13/ACT-1197 durable).
  Foundation audit one layer below: every foundation defect is surfaced in-spec with same-PR fix or
  tracked ACT (JPL misroot P20-instance, mesh-block construction, annotateOutcome append-many,
  readRedacted scan shape, jp- id collision, pool-branch Bearer guard, prune-timer gap, router
  shared-options, CBIP bypass spread, hog in-memory ledger). ELI16 verified updated to v5.
  Honesty record: .instar/memory/feedback_*.md absent on this agent.

## Round 5 verdict + FOLD → v6
Round 5: NOT clean — 1 MATERIAL (ADV5-1) + minors (SEC 2, ADV 4, INT 3, codex 1). LES/DC/SCAL fully
clean. Round 6 = fresh confirmation round on v6.
Folded into v6: ADV5-1 census component-key uniqueness as a census-test ASSERTION + honest
review-caught residual for unenrolled-undeclared same-key points (§5.6 + Ratchet fixtures); ADV5-m1
rung-registry owning-component column + annotate-chokepoint owner rejection (§5.4.2 + Testing);
ADV5-m2 parentPid guarantee tightened to ENACTED kills (§5.3); ADV5-m3 exempt baseline pinned
shrink-only (§5.6 + Ratchet fixtures); ADV5-m4 grade-pass global-bound fairness honesty + named
per-point sub-budget trigger at third enrollment (§5.5); CX5-2 insufficient-evidence marker below
minSampleForRates (default 20; §5.5 + config keys + Testing); SEC5-m1 onCorrelationId try/catch
containment (§5.1.4 + Testing); SEC5-m2/INT5-m1 hog store backup exclusion by ACTIVE
REMEDIATION_EXCLUDED_PATH_PREFIXES entry (§5.3); INT5-m2 CapabilityIndex /judgment-provenance text
update same-PR (§5.7); INT5-m3 anchor cites re-grounded (:3707, :1457-1464 noted).
NOT folded (advisory/dissent, recorded): CX5-1 dedicated column (documented tradeoff), CX5-3 adapter
plugins (registry IS the seam), CX5-4 (already required), CX5-5 shadow-write (deliberate staging).

## Round 6 (confirmation round on v6)
- v6 commit f2c104096; spec file sha256 ee9ba60455ca24c2f332b937638ecd5e29a86eb6a8e1cdf0020665731b2cb8fd
- Conformance gate: ran — the SAME 2 known artifacts (stale-checker traceability; disposed
  Operator-Surface Quality). No new flags.
- codex r6: RAN ok (gpt-5.5) — MINOR ISSUES. Dispositions:
  CX6-1 verdict_id polymorphic — THIRD re-argument of the recorded dissent (CX4-1/CX5-1). Non-material.
  CX6-2 "why not append-only event log + materialized rollup" rationale absent — cheap honesty add:
    fold ONE decision-record sentence into §5.5 (alternative considered; recompute-bucket + bounded
    reconcile chosen because grades are LOW-VOLUME mutable facts over indexed keys — the event-log
    machinery would be a second bespoke store for the same guarantees). Editorial fold at close.
  CX6-3 grade-name over-trust / no-blended-rate hard invariant — re-argues FD3 (frontloaded taxonomy)
    + already-folded CX4-2/CX5-2 strength-first default + insufficient-evidence marker. Dissent
    recorded, non-material.
  CX6-4 undeclared-point residual "is material; require typed id per evaluate() at graduation" —
    re-argues the ADV5-1 disposition (residual NAMED + uniqueness-pinned; settlement write already
    validates decisionPoint ∈ census for enrolled calls). Dissent recorded with note: callsite-
    granular mandatory enrollment is a possible FUTURE tightening at graduation, not this build.
  CX6-5 per-rule coverage/unknown-rate prominence at first release — cheap honesty add: fold ONE
    sentence into §5.7 graduation (phase-4 checklist reads per-rule unknown-rates as a product
    signal, low evidence density = a finding to act on, not just a metric state). Editorial fold.
  CX6-6 context caveat — disclosure only.
- gemini r6: DEGRADED (timeout) — 5th consecutive. Per-round record: gemini ok r1+r2, timeout
  r3-r6; codex ok all 6 rounds → spec-level flag stays clean RAN (codex-cli:gpt-5.5).
- R6 SCALABILITY: PASS 0/0 — independently verified the v5→v6 diff touches ONLY the three doc files
  and exactly the ten claimed deltas; every delta no-regression (uniqueness/exempt pins = CI-time;
  owner rejection = O(1) off-hot-path; parentPid precision REMOVES a latent write-error-loop risk;
  marker = read-side boolean; try/catch free on non-throw path; backup entry off hot path). Fresh
  sweep clean; no new accumulating state.
- R6 SECURITY / DECISION-COMPLETENESS / LESSONS-AWARE / INTEGRATION: ONE SHARED MATERIAL — four
  independent reviewers converged: the SEC5-m2/INT5-m1 fold pins the WRONG BackupManager constant.
  BackupManager.ts:89 is the 'judgment-provenance' entry of NEVER_BACKUP_PATH_SEGMENTS (:88-90,
  UNCONDITIONAL, segment-matched — the mechanism that ACTUALLY excludes the JP dir);
  REMEDIATION_EXCLUDED_PATH_PREFIXES (:71-77) is a DIFFERENT, remediation-flag-GATED list
  (isRemediationEnabled() :193-195/:207 — inert on default agents) with .instar/-rooted spelling that
  mismatches stateDir-relative includeFiles resolution. As-written implementation = silent no-op =
  the SEC4-1 defect class reproduced in the backup layer (INT honestly records the mis-pin originated
  in its own r5 finding text). SEC additionally grounded (c): ALL deny checks are ENTRY-level
  (resolveIncludedFiles :196-217, createSnapshot :288-307) and the directory-copy branch (:311-328)
  copies direct file children with NO per-file re-check — so the clause's own named threat (a bare
  'state/' includeFiles glob) defeats even a correctly-pinned entry; the JP dir survives only
  incidentally (subdirectory + non-recursive copy). Pre-existing sibling exposure (pr-hand-leases,
  self-action-governor) filed as ACT-1201.
  CONVERGED v7 FIX (union of the four reviewers): (i) the store joins BOTH unconditional mechanisms —
  BLOCKED_PATH_PREFIXES as the stateDir-relative literal 'state/external-hog-decisions.json'
  (BackupManager.ts:30-52; the 'state/pr-hand-leases.json' per-machine-state precedent whose comment
  pins "Unconditional (NOT the remediation-gated F-7 list); stateDir-relative prefixes") AND
  NEVER_BACKUP_PATH_SEGMENTS filename segment 'external-hog-decisions.json' (:88-90) — never the
  remediation list; correct the JP-mechanism attribution; (ii) the directory-copy branch re-applies
  the blocked/never-backup checks to path.join(entry, file) per copied file in the same PR (closes
  the state/-glob threat for real + the ACT-1201 latent gap); (iii) Testing: seed
  includeFiles ['state/'] with remediation OFF under the production layout, assert the snapshot
  omits the store.
  All other folds verified GENUINE by all four (SEC5-m1 containment; ADV5-m1 owner rejection;
  ADV5-m2 ENACTED-kill scoping; ADV5-1 uniqueness + residual; CX5-2 marker incl. config-key join;
  INT5-m2 CapabilityIndex :123-125 verified; INT5-m3 anchors exact; conformance dispositions
  undisturbed; Standard A/B + migration parity + rollback unchanged — 13-hunk diff fully accounted).
  LES r6 minor 1 (fold): the third-enrollment sub-budget trigger is prose — make it structural: a
  census-test assertion that >2 ENROLLED points requires the per-point sub-budget. DC/INT: 0 minors.
- R6 pre-existing disclosure: ACT-1201 filed (BackupManager directory-copy per-file bypass affects
  existing BLOCKED_PATH_PREFIXES siblings today; one-loop fix rides this build's PR, ACT survives
  descoping).
- R6 ADVERSARIAL (filed after nudge — slow, not dead; stall + nudge recorded): FINDINGS — 1 MATERIAL
  = the SAME §5.3 backup mis-pin, independently derived with full code grounding BEFORE the
  coordinator's heads-up (FIFTH independent confirmation; cite precision: the remediation list is
  :71, not :89). Attack extension: pin the per-file segment re-check as the INVARIANT — the JP dir
  survives a state/ glob today only by the non-recursive-copy ACCIDENT (isFile() :321), and a future
  recursive-copy enhancement would silently re-expose both stores (folded as an explicit invariant
  clause in §5.3). All ADV5 folds verified GENUINE; all r3/r4 resolutions INTACT.
  ADV6-m1: §5.1.1 "linked by the component key" flatly contradicts the §5.6 uniqueness assertion —
  FOLDED (each multi-call point gets its OWN suffixed unique key; linkage ONLY via the composition
  field; §5.6 scope precision: uniqueness binds wired + deterministic-only-exempt keys).
  ADV6-m2: "equivalently every floorPermitted kill" false set-equivalence vs the soak sentence —
  FOLDED ("a fortiori in-hand for", permitted ≠ enacted named).
  ADV6-m3: four annotation-rejection classes counted but never SERVED (renamed grading component's
  rejections would silently starve enacted-disposition preconditions, only trace in catch-logs) —
  FOLDED (rejection counters by class join the route's served counter block).

## Round 6 verdict + FOLD → v7
Round 6: NOT clean — ONE shared MATERIAL, independently converged by FIVE reviewers (SEC, DC, LES,
INT, ADV — each with line-level code grounding; INT traced the mis-pin's origin to its own r5
finding text): the r5 backup-exclusion fold pinned the flag-gated REMEDIATION_EXCLUDED_PATH_PREFIXES
list — a production no-op on default agents (the SEC4-1 defect class reproduced in the backup layer,
IN a fold — proof the confirmation rounds check the folds themselves). SCAL: PASS 0/0.
Folded into v7: the converged backup fix (BLOCKED_PATH_PREFIXES stateDir-relative literal +
NEVER_BACKUP_PATH_SEGMENTS filename segment — BOTH unconditional, never the remediation list;
per-file re-check inside the dir-copy branch pinned as the INVARIANT vs the non-recursive accident;
threat-shaped test: includeFiles ['state/'] + remediation OFF + production layout → snapshot omits
the store); LES6-m1 structural sub-budget trigger (census-test asserts >2 enrolled points requires
the sub-budget); ADV6-m1 multi-call key uniqueness resolution + scope precision; ADV6-m2 a-fortiori
wording; ADV6-m3 served annotation-rejection counters by class; CX6-2 append-only-alternative
decision record (§5.5); CX6-5 per-rule unknown-rate as product signal at graduation (§5.7).
Dissents recorded not folded: CX6-1 (3rd re-argument), CX6-3 (re-argues FD3 + folded defaults),
CX6-4 (re-argues ADV5-1 disposition; callsite-granular enrollment noted as possible future
tightening). Pre-existing: ACT-1201.
Round 7 = fresh full confirmation round on v7.

## Round 7 (confirmation round on v7)
- v7 commit 557d25b33; spec sha256 bd712bd05c812e5e62465c556e1554fc5926bdd9bd2b7fde78de527e47ad1988
- Conformance gate: ran — ZERO flags (the stale-checker artifact is non-deterministic: flagged
  r1/r4/r5/r6, clean r2/r3/r7).
- codex r7: RAN ok (gpt-5.5) — MINOR ISSUES. Dispositions:
  CX7-1 verdict_id (4th re-argument) — dissent stands; NEW nugget folded editorially: a one-clause
    deprecation trigger (any future legitimate llm-kind verdict_id READER triggers the
    dedicated-column migration — the lint makes such a reader visible at introduction).
  CX7-2 canonical winning-grade derivation — GENUINE cheap build-shape pin: ONE canonical
    winning-grade-per-correlation-id derivation (single SQL view/function) that BOTH the route reads
    and the rollup recompute derive from — never parallel logic. Editorial fold (§5.5).
  CX7-3 strength-segmented right — ALREADY the design (CX4-2/CX5-2 folds). Non-material repeat.
  CX7-4 heuristic evaluate()-callsite inventory — re-argues the ADV5-1/CX6-4 disposition; folded a
    LIGHT version editorially: the census test also emits an informational (non-blocking) static
    count of router-evaluate callsites per component vs declared points — a drift hint, not a gate.
  CX7-5 glossary (= GM7-1, both externals converge) — folded: compact glossary block added to the
    spec (the r2 ELI16-is-the-surface disposition held two rounds; both models still flagged density
    — the spec itself now carries the 10-line glossary).
  CX7-6 context caveat — disclosure (parent-standard "full context" reading; LES3-m4's deliberate-
    reading acknowledgment already in Non-goals + verified against registry:523 in r5/r6).
- gemini r7: RAN ok (gemini-3.1-pro-preview) — FIRST success since r2 (timeouts r3-r6). MINOR ISSUES:
  GM7-1 glossary — folded (above).
  GM7-2 OpenTelemetry instead of bespoke correlation — dissent + one-sentence decision record folded
    (§5.1): single-process seam, zero OTel substrate in the codebase, ids join EXISTING SQLite
    metrics rows; OTel adds machinery without adding a guarantee here.
  GM7-3 dedicated audit-trail service/library — dissent + decision-record sentence (§5.3): the
    file-based no-external-service posture is a repo-level design decision; the custom-risk point is
    conceded and answered by the threat-shaped tests this review added.
- Internals r7: all six launched.
- R7 SCALABILITY: PASS 0/0 (5th consecutive clean, r3-r7). Diff completeness verified
  (f2c104096..557d25b33 = 9 hunks, all mapped to the claimed deltas, nothing unclaimed). Per-file
  backup re-check costed: ~9 string ops vs 2×statSync+copyFileSync per file (<1% even at a 10k-file
  glob) and REDUCES I/O when it fires; createSnapshot episodic + already-sync. Served rejection
  counters = 4 integers. Fresh sweep clean (hot path, growth, concurrency, event loop, fail-open all
  unchanged or strengthened).
- R7 SECURITY: PASS, 0 material, 2 MINOR (one-clause pins on PRE-EXISTING adjacent defects, not v7
  design defects). Full r6-fold walk-through GENUINE (BLOCKED_PATH_PREFIXES :30-52 + precedent :43;
  NEVER_BACKUP_PATH_SEGMENTS :88-90/:200; remediation list confirmed flag-gated; per-file re-check
  verified LOAD-BEARING not belt-and-suspenders — entry 'state/' passes every entry-level list;
  threat-shaped test is the shape that would have caught the r5 mis-pin). Served rejection counters
  leak nothing (4 fixed enum classes, counts only). ALL r1-r5 resolutions intact with anchors.
  SEC7-m1 (fold): per-file re-check must enumerate ALL THREE deny mechanisms — BLOCKED_FILES
  (basename arm; the ONLY per-file protection for config.json [authToken/dashboardPin] under an
  includeFiles ['./'] root glob — entry basename '.' passes every entry-level check) +
  BLOCKED_PATH_PREFIXES + NEVER_BACKUP_PATH_SEGMENTS; Testing line: ['./'] → snapshot omits
  config.json.
  SEC7-m2 (fold + ACT update): the remediation list is DOUBLY inert — flag-gated AND misrooted
  ('.instar/'-rooted spelling vs stateDir-relative entry resolution, the SEC4-1 root-divergence trap
  again); add the misrooting to ACT-1201's scope so the pre-existing broken guard is durably tracked.
- R7 DECISION-COMPLETENESS: PASS, 0 material, 3 cosmetic minors — "CONVERGED (round-4/5 declarations
  re-affirmed on v7)". R6 material verified genuinely resolved with full code grounding (both
  constants unconditional + correctly rooted; the v6 self-contradiction gone; per-file re-check
  implementable without asking — exactly ONE dir-copy branch; threat-shaped test cannot pass via the
  gated list). Counts: FD=13, cheap=1 (FD6, cleared), open-user-decisions=0.
  DC7-m1 (fold, cosmetic): the "Unconditional…" comment sits at BackupManager.ts:34-36 on the
  pending-inbound block, not the pr-hand-leases entry — cite precision, rides INT5-m3 build re-ground.
  DC7-m2 (fold): mirror the >2-enrolled sub-budget census assertion in §Testing's Ratchet-fixtures
  enumeration (every sibling assertion is enumerated there).
  DC7-m3 (fold): one parenthetical — unregistered ruleId buckets under rung-mismatch;
  unknown-decisionPoint = the §5.1.4 settlement census-miss counter served in the same block.
- R7 INTEGRATION: PASS, 0 material, 3 minor. R6 fold verified GENUINE + BUILDABLE end-to-end
  (constants correct + correctly rooted; per-file re-check straightforward — path.join already
  computed at :325; threat verified LIVE: a state/ glob passes both entry-level checks and WOULD copy
  the store today). Delta discipline: 9 hunks all accounted; Standard A/B, migration parity, config
  surface, rollback all untouched (the delta adds only in-repo constants shipping in dist — no
  agent-installed-file surface).
  INT7-m1 (fold → ACT-1201 scope): restoreSnapshot (:452-467) is UNFILTERED (path-containment only) —
  name pre-fix snapshots as a residual or apply the deny checks at restore.
  INT7-m2 (fold): add state/pending-inbound.<agentId>.sqlite to the §5.3 sibling enumeration —
  in-flight message custody state, exactly the class whose cross-machine restore the store's own
  comment forbids.
  INT7-m3 = DC7-m1 (cite precision, converged).
- R7 LESSONS-AWARE: PASS 0 material, 2 minor (Testing echo of the sub-budget assertion = DC7-m2;
  ELI16 currency — the v7 backup-arc + ACT-1201 disclosure paragraph). Full r6-fold verification
  genuine with code grounding; conformance dispositions undisturbed; full P1-P23/L1-L17/B1-B39 sweep
  clean; honesty record: feedback_*.md absent.
- R7 ADVERSARIAL: PASS 0 material, 2 minor — CLEAN CONFIRMATION. All r6 folds verified genuine
  (incl. tmp-sibling coverage under the pinned ArmStore naming); ALL r3-r6 resolutions line-checked
  intact on v7. ADV7-m1 (= SEC7-m1, independent convergence): per-file re-check must apply ALL THREE
  deny layers incl. BLOCKED_FILES (the './' root-glob → config.json case, verified against node path
  semantics) + Testing asserts the ACT-1201 siblings. ADV7-m2: census-key uniqueness binds EVERY
  entry regardless of status (pending/no-decision-content carve-out attacks named — absorbed
  census-pending activity; wired-but-silent false-flag). Non-landed attacks recorded: tmp-sibling
  smuggling, alternate-spelling/..-traversal, restore-side reintroduction (crafted snapshot = fs
  access, out of threat model), sub-budget assertion gaming, rejection-class completeness.

## ROUND 7 VERDICT: CLEAN — CONVERGED AT ROUND 7
All six internals PASS at material level + both external families RAN (codex 7/7, gemini r1/r2/r7) +
conformance gate ZERO flags. Criteria: (1) zero material new issues — SATISFIED; (2) zero unresolved
user-decisions (Open questions empty, FD=13, cheap=1 cleared) — SATISFIED.
All r7 minors folded EDITORIALLY into the converged text (v8): glossary (both externals); canonical
winning-grade derivation (CX7-2); verdict_id deprecation trigger (CX7-1); informational callsite
inventory (CX7-4); OTel + audit-library decision records (GM7-2/3); three-layer per-file re-check +
config.json test (SEC7-m1/ADV7-m1); uniform census-key uniqueness (ADV7-m2, supersedes the r6
carve-out); ACT-1201 scope adds (restore residual INT7-m1, pending-inbound sibling INT7-m2,
doubly-inert remediation list SEC7-m2); Testing echoes (DC7-m2/LES7-m1, sibling asserts); rejection-
class precision (DC7-m3); cite precision (DC7-m1/INT7-m3); ELI16 backup-arc paragraph (LES7-m2).
D7 per-round model disclosure: internals claude-fable-5 all rounds (harness subagents);
externals codex-cli:gpt-5.5 (7/7 ok), gemini-cli:gemini-3.1-pro-preview (ok r1/r2/r7, timeout r3-r6).
Convergence report: docs/specs/reports/llm-decision-quality-meter-convergence.md (banner, ELI10,
Original-vs-Converged, iteration table, full catalog, verdict — complete).
Next: stamp via write-convergence-tag.mjs (iterations 7, cross-model codex-cli:gpt-5.5, FD=13
cheap=1 contested-cleared=2) → operator sign-off package → build on approval.
