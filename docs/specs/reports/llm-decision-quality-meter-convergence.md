# Convergence Report — LLM-Decision Quality Meter — uniform provenance + outcome grading

## Cross-model review: codex-cli:gpt-5.5

RAN — a real GPT-tier external pass ran through the agent's codex CLI in EVERY round (7/7), and a
real Gemini-tier pass ran in rounds 1, 2, and 7 (the confirmation round itself had BOTH external
families). Gemini's r3–r6 timeouts are recorded per-round below — never hidden, never counted as
passes.

Per-round record so far:
- Round 1: codex-cli:gpt-5.5 RAN ok (verdict: SERIOUS ISSUES, 6 findings); gemini-cli:gemini-3.1-pro-preview
  RAN ok (verdict: MINOR ISSUES, 4 findings). Anthropic clean-door reviewer: refused
  `no-supported-framework` (config-disabled on this agent) — disclosure only, never a cross-model pass.
- Round 2: codex-cli:gpt-5.5 RAN ok (verdict: MINOR ISSUES, 5 points + 1 context caveat);
  gemini-cli:gemini-3.1-pro-preview RAN ok (verdict: MINOR ISSUES, 3 points).
- Round 3: codex-cli:gpt-5.5 RAN ok (verdict: MINOR ISSUES — "no serious architectural blocker", 5
  refinements); gemini-cli DEGRADED (timeout) — recorded honestly; the spec-level flag stays clean via
  the r1/r2 successes.
- Round 4: codex-cli:gpt-5.5 RAN ok (MINOR ISSUES — dispositions folded/recorded); gemini-cli
  DEGRADED (timeout, 2nd consecutive).
- Round 5: codex-cli:gpt-5.5 RAN ok (MINOR ISSUES — 1 fold, 4 dissents recorded); gemini-cli
  DEGRADED (timeout, 3rd).
- Round 6: codex-cli:gpt-5.5 RAN ok (MINOR ISSUES — 2 editorial folds, re-arguments recorded);
  gemini-cli DEGRADED (timeout, 4th consecutive on this spec — the known deprioritized gemini service,
  zombie-alive since June 18; every timeout recorded per-round, never hidden).

## ELI10 Overview

The agent makes hundreds of automated judgment calls a day using AI models — "kill this runaway
process?", "is this autonomous run really done?", "block this message?". Today there is an excellent
COST meter for those calls (which model, how many tokens, how fast) but no QUALITY meter: nothing
records what a judge looked at, and nothing ever finds out whether it was right. This spec builds the
quality meter: every AI decision gets a correlation id automatically; important decision points
opt in to recording what they saw and chose; reality-based evidence rules grade decisions
right/wrong/honestly-unknown after the fact (a killed process's owner really was dead; the "done" run
really passed its check); and one read surface answers, per decision point, "how often is this judge
right — does it need a bigger model or a better prompt?". Everything is observe-only, ships dark, and
keeps full detail on the machine that made the decision.

The main tradeoffs: more recording (bounded, clamped, volume-capped) in exchange for auditability;
only the two highest-stakes decision points wire up first (the rest become a visible, re-surfaced
backlog); and grades are honest — "unknown" and "too little evidence" are first-class answers, never
dressed up as rates.

(See also the ELI16 companion `docs/specs/llm-decision-quality-meter.eli16.md`.)

## Original vs Converged

*(written at convergence; the load-bearing round-1 changes, in plain English:)*

Originally, the spec claimed callsites would inherit provenance "with zero edits," graded outcomes with
loosely-named signals, let every LLM decision row bypass sampling, and served a quality report by
re-reading the raw provenance files on every request. Review changed all four: enrollment is now an
explicit per-callsite contract (correlation is automatic; provenance is work); outcome grades are
produced only by precise, versioned evidence rules with attribution, precedence, and idempotent writes
(so a coincidence — like the operator reopening their editor — can't mislabel a correct kill as wrong,
and a component can't grade its own work as right); volume classes replace the blanket sampling bypass
(measured real volume: ~4,100 LLM calls/day would have made the store unbounded-by-anything-but-time);
and the report reads from small indexed database tables written at decision time — the raw files are
never scanned by the web route (the exact event-loop-freeze shape that wedged this laptop's server the
week before was caught in review before a line was written).

The later rounds hardened what round 1 designed. Round 2's biggest catch: the record-keeper the
kill-grading depends on didn't exist — the spec had assumed an in-memory ledger (one-hour retention,
kills only) could carry evidence for a six-hour window; the durable hog decision store is now a named
deliverable. Rounds 3–4 made the evidence rules spoof-proof: grading now keys on recorded process
birth-times (which cannot be forged backwards), a lookalike process cannot frame a correct kill or a
correct spare, and the parent-process identity is recorded member-wise so the rule stays evaluable in
the dominant orphan-kill case. Round 4 also surfaced a LIVE pre-existing defect in shipped code — the
never-serve rule protecting the decision-provenance log is a production no-op due to path-root
divergence, leaving grading ground truth viewable AND editable in the dashboard file editor today
(tracked ACT-1200; fixed in this build's PR, with the serve-discipline tests re-pinned to the layout
production actually produces). Round 5's material catch closed a census blind spot: coverage
discovery was component-keyed while declarations are per decision point, so a second judgment hiding
under a declared sibling's identity would have skipped every guard layer — identity reuse is now a
test failure, and the one genuinely undetectable case is named in the spec as a review-time residual
rather than implied away. Throughout, the read surface accumulated honesty invariants: aggregates
group by evidence strength first, tiny samples are marked "insufficient evidence" rather than served
as rates, and expired/unknown/not-written are three distinct reported states, never conflated.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security(6M), scalability(4M), adversarial(8M), integration(8M), decision-completeness(6M), lessons-aware(8M), codex(SERIOUS,~5M), gemini(minor), conformance-gate(3 flags) | ~40 material (heavy overlap; ~12 distinct clusters) | Full rewrite (v2, commit fbc3c06ef): correlation spine redesigned (FD1/FD7/FD8), quality substrate (3 SQLite tables + 90d rollup), volume classes (FD4 amended), outcome write-integrity + evidence-rule predicates, content classes, JP construction unconditional (FD9), cross-machine honesty (FD10), grading deterministic-only (FD11), Migration-parity + Testing sections, census hardening, FD count 6→13, 3 tracked deferrals minted (ACT-1197/1198/1199) |
| 1 | Standards-Conformance Gate: ran (3 flags — parent-standard traceability [resolved: checker staleness, standard verified at registry:522 + parser run extracting 74 articles], maturation-path posture [resolved: FD6 exact DEV_GATED_FEATURES language], testing-integrity [resolved: Testing section added]) | — | — |
| 2 | security(3M), scalability(4M), adversarial(8M), integration(3M), decision-completeness(3M), lessons-aware(5M), codex(MINOR,5), gemini(MINOR,3), conformance-gate(1 flag) — EVERY round-1 resolution independently verified GENUINE by all six internals | 26 material | v3 rewrite (408 ins/244 del): durable hog decision store (false-anchor carrier replaced), settlement = every evaluate() exit, per-attempt capture scoping, ruleId→rung registry + within-rung conservative order, rollup mutation semantics + read-derived expired, b-/d- mint prefixes + joinMiss split, kind:'llm' scoping, funnel-wrapper strip, charset clamps, per-table prune + attribution columns, pending-ACT liveness + pinned ACTs, typed census registration + envelope builders, exempt-but-active flag, recorder-singleton seam |
| 3 | Standards-Conformance Gate: ran (0 flags — 3→1→0 across rounds). Externals: codex MINOR ("no serious architectural blocker", 5 refinements), gemini degraded-timeout. Internals: security(3M), integration(4M), lessons-aware(2M), adversarial(5M), decision-completeness(2M), scalability(PASS) | 16 material — ALL narrow pins, zero structural rework; every r2 fold verified genuine by every reviewer | v4 (commit c81ad2d1e): hog store → state/ subdir + NEVER_SERVED + explicit at-rest posture; targetTuple spoof-proof kill-time ordering re-test; leave-recurrence keyed on same-process signature; sustained-right sensor bound; enacted enum → real 10-value disposition space; grade-on-supersede + in-window kill slot retention; retention += gradingSlack; pending-ACT honest CI/runtime split (3 reviewers converged); evidence-strength classes per rule; mint marker on router-internal clone + single-use consumption; 4th table (grading cursor) + backoff; 6h-timer reconcile + construction-condition quality arm; dryRun suppresses all durable writes; graduation counter checklist; kind-scope query lint |
| 4 (confirmation) | Conformance gate (1 flag — known stale-checker artifact). codex MINOR (3 one-sentence folds + dissents). gemini degraded-timeout. scalability(PASS), decision-completeness(PASS — "CONVERGED at round 4"), adversarial(1M), security(1M). integration + lessons-aware: NO VERDICT (host session respawn killed both mid-review — recorded, NOT counted as passes, re-run r5) | 2 material (ADV4-1 member-wise ownerTuple; SEC4-1 misrooted NEVER_SERVED — also a LIVE pre-existing defect, tracked ACT-1200) | v5 (commit 324ebe802): member-wise ownerTuple recording (both bad implementer exits closed); projectDir-relative NEVER_SERVED literal pinned + existing JP entry dual-rooted/fixed same-PR + tests pinned to PRODUCTION layout; dedicated-column rejection rationale; strength-first default aggregate view; dryRun-staging honesty clause |
| 5 (confirmation) | Conformance gate (2 flags — both known artifacts). codex MINOR (1 fold: insufficient-evidence marker; 4 dissents recorded). gemini degraded-timeout. scalability(PASS 0/0), decision-completeness(PASS — re-affirmed), lessons-aware(PASS 0/0 CLEAN), security(PASS + 2 minors), integration(PASS + 3 minors; independently REPLICATED the ACT-1200 live defect), adversarial(1M + 4 minors) | 1 material (ADV5-1: census discovery component-keyed vs per-point declarations — same-key reuse silently skips every guard layer) | v6 (commit f2c104096): census component-key uniqueness as census-test ASSERTION + named review-caught residual; rung-registry owning-component + annotate-chokepoint owner rejection; parentPid guarantee scoped to ENACTED kills; exempt baseline pinned shrink-only; grade-pass fairness honesty + per-point sub-budget trigger; insufficient-evidence marker below minSampleForRates=20; onCorrelationId try/catch containment; hog-store ACTIVE backup-exclusion entry; CapabilityIndex same-PR update; anchors re-grounded |
| 6 (confirmation) | Conformance gate (2 known artifacts, no new). codex MINOR (2 editorial folds + re-argument dissents). gemini degraded-timeout. scalability(PASS 0/0, independent v5→v6 diff verification). security(1M + 1 pre-existing disclosure), decision-completeness(1M), lessons-aware(1M + 1 minor), integration(1M), adversarial(1M + 3 minors, filed after nudge — slow not dead) | 1 shared material, independently converged by FIVE reviewers with line-level code grounding: the r5 backup-exclusion fold pinned the flag-gated REMEDIATION_EXCLUDED_PATH_PREFIXES list — a production no-op on default agents (the SEC4-1 no-op-guard class reproduced INSIDE a fold; INT traced the mis-pin to its own r5 finding text). Plus SEC's deeper catch: ALL BackupManager deny checks are entry-level and the dir-copy branch has no per-file re-check (pre-existing sibling exposure → ACT-1201) | v7 (commit 557d25b33): backup fix — BOTH unconditional mechanisms (BLOCKED_PATH_PREFIXES stateDir-relative literal + NEVER_BACKUP_PATH_SEGMENTS filename segment), per-file re-check pinned as INVARIANT vs the non-recursive-copy accident, threat-shaped test (state/ glob + remediation OFF → snapshot omits store); structural >2-enrolled-points sub-budget census assertion; multi-call composition = own unique key per point, linkage only via composition field; a-fortiori parentPid wording; annotation-rejection counters SERVED by class; append-only-alternative decision record; per-rule unknown-rate as graduation product signal |
| 7 (confirmation — CONVERGED) | Conformance gate: ZERO flags. codex MINOR (glossary + 2 build-shape pins + re-arguments). gemini RAN ok — first since r2 — MINOR (glossary + 2 architecture dissents, decision-recorded). ALL SIX internals PASS at material level: scalability(0/0, 5th consecutive, diff-completeness verified), security(0/0 + 2 pre-existing-adjacent minors), decision-completeness(0/0 + 3 cosmetic minors, "CONVERGED re-affirmed"), integration(0/0 + 3 minors, live threat replication), lessons-aware(0/0 + 2 minors, full P/L/B sweep), adversarial(0/0 + 2 minors, tmp-sibling & traversal & restore attacks non-landed) | ZERO material — the clean confirmation round (criteria: no material new issues + zero open user-decisions, both satisfied) | Editorial-only close-out folds (v8): glossary; canonical winning-grade derivation; verdict_id deprecation trigger; informational callsite inventory; OTel + external-audit-library decision records; per-file re-check enumerates ALL THREE deny layers incl. BLOCKED_FILES (config.json under a './' glob — SEC+ADV independent convergence); uniform census-key uniqueness (supersedes the r6 carve-out); pending-inbound joins the ACT-1201 sibling enumeration + restore-path residual + doubly-inert remediation-list disclosure into ACT-1201 scope; Testing echoes (sub-budget assertion, sibling omission asserts, config.json case); ELI16 backup-arc paragraph |

**Convergence achieved at round 7** under the two additive criteria: the confirmation round produced
zero material findings across all six internal perspectives + both external model families + the
zero-flag conformance gate, and zero unresolved user-decisions remain (every open question resolved
into the 13 Frontloaded Decisions). Rounds 4, 5, and 6 were each ATTEMPTED confirmation rounds that
found real material (2, 1, and 1 findings respectively) — each was folded and re-confirmed rather
than argued away, including round 6's five-reviewer catch of an error in the review's OWN round-5
fold. The convergence is earned, not asserted.

## Full Findings Catalog

### Round 1 — Standards-Conformance Gate (3 flags)
1. **Constitutional Traceability** — parent standard "Decision Provenance & Outcome Review" not in the
   checker's list. **Resolution: resolved-stale.** The standard exists at docs/STANDARDS-REGISTRY.md:522
   in the worktree (ratified PR #1436, merge 965a3602c); the lessons-aware reviewer ran the worktree's
   built parser and extracted 74 articles including it. The deployed checker's dist predates the merge.
   Spec change: parent-standard line now cites the registry heading + ratifying SHA.
2. **Maturation Path** — "dev-gated dark, dryRun-first on dev" flagged. **Resolution:** FD6 rewritten
   with the exact registry posture (DEV_GATED_FEATURES omit-key semantics → LIVE-on-dev/DARK-fleet,
   dryRun TRUE until deliberate flip, migrateConfig never seeds).
3. **Testing Integrity** — no test-tier plan. **Resolution:** full Testing section added (all tiers +
   redaction semantic suite + existing-test sweep + injected clocks + perf assertions).

### Round 1 — external: codex-cli:gpt-5.5 (verdict SERIOUS ISSUES)
1. Correlation-id ambiguity (no schema field; which id lands in verdict_id) → **folded**: §5.2 additive
   fields; FD8 single-writer rule.
2. "Zero callsite edits" overclaim → **folded**: §5.1 split into Layer A (automatic correlation) vs
   Layer B (enrollment contract).
3. Outcome grading underspecified (no event sources/windows/conflict rules) → **folded**: §5.4 evidence
   rules with ruleId predicates, windows, precedence.
4. LLM evidence-interpreter risk (ungraded LLM grading LLMs) → **folded**: FD11 deterministic-only;
   LLM rung dormant behind tracked activation gate.
5. Ratchet on components ≠ decision points → **folded**: §5.6 census keyed per decision point.
6. 14-day retention vs longitudinal grading → **folded**: §5.5 90-day content-free rollup + expired-vs-
   unknown honesty.

### Round 1 — external: gemini-cli:gemini-3.1-pro-preview (verdict MINOR ISSUES)
1. Jargon density → glossary handled in ELI16 companion (accessibility surface); noted.
2. Redaction robustness (scrubber is the load-bearing guarantee) → **folded**: Testing redaction/scrub
   semantic suite over the new writer payload shapes.
3. 64KB clamp truncation risk → **folded**: §5.2 content classes prioritize identity/bounded features;
   decision-critical fields never rely on surviving a bulk clamp.
4. Seam overhead profiling → **folded**: Testing perf assertion.

### Round 1 — internal: SECURITY (6 MATERIAL, 2 minor)
M1 raw response head in unscrubbed HTTP-served `decision` field → **folded**: §5.2 served-field bounding.
M2 hog argv (attacker-controllable; scrub is credential-shape-only) crossing HTTP/pool → **folded**:
  §5.2/§5.3 argv excluded, identity fields only.
M3 free-form evidence notes served unbounded → **folded**: ≤500-char clamp + pointer discipline at
  annotate time.
M4 unfenced grading interpreter + full-tool tier-1 job → **folded**: FD11 dormancy + FENCE +
  injection-exposed registration on activation; job body never interprets (curl-only).
M5 no content-discipline rule for message-carrying retrofits → **folded**: §5.2/§5.6 content classes.
M6 missing test plan for redaction invariants → **folded**: Testing section semantic suite.
m1 pool fan-out peer-URL credential guard + field allowlist (adjacent route unguarded) → **folded**:
  §5.5 + same-build retrofit of routes.ts:15031.
m2 strip options.provenance before inner delegation → **folded**: §5.1.6.

### Round 1 — internal: SCALABILITY (4 MATERIAL, 2 minor)
S1 /decision-quality JOIN = ~500MB sync JSONL parse on event loop (EvolutionManager wedge shape;
  measured 1,264 llm rows/day, ~33KB avg context) → **folded**: §5.5 substrate (route never scans JSONL).
S2 FD4 blanket arbiter-bypass removes the only volume valve (tone gate ~98KB contexts > 64KB clamp =
  degenerate clamp path on every row) → **folded**: FD4 volume classes + droppedByBudget.
S3 correlation-id → outcome plumbing keys don't line up; in-memory pending-registry leak class →
  **folded**: §5.1.4 onCorrelationId + durable per-callsite persistence + no-shared-registry rule.
S4 grading job unbounded (no cursor/ceiling/idempotency) → **folded**: §5.5 cursor + maxDecisionsPerPass
  + upsert idempotency.
m verdict_id index → **folded** (substrate PK/indexes). m pool guardrails → **folded** (§5.5 + FD13
  poll-cache note).

### Round 1 — internal: ADVERSARIAL (8 MATERIAL, 3 minor)
M1 id no-home/no-return (= S3/DC-M1) → **folded** (§5.1/§5.2).
M2 N decision rows per decision under failure-swap → **folded**: FD7 write-once at settlement +
  errored-settlement row.
M3 annotateOutcome grade laundering/self-grading → **folded**: §5.4 gradedBy + precedence + idempotent
  upsert + count-once.
M4 coincidence evidence mislabels (VS Code reopen = "respawn") → **folded**: §5.4 precise predicates +
  ruleId + per-rule breakdown.
M5 grade-injection via row content → **folded**: FD11 dormancy + envelope mandate on activation.
M6 retention mismatch orphan classes → **folded**: substrate + expired-vs-unknown + orphan counters.
M7 'wired' self-declared → **folded**: §5.6 static source check + wired-but-silent runtime flag.
M8 dual-writer verdict_id + caller-injectable id → **folded**: FD8 unconditional mint/overwrite +
  mintedBy + callerRef relocation + collision-resistant ids.
m1 pending:<ACT> validation → **folded** (§5.6). m2 mixed-sampling ratio distortion → **folded** (§5.5
  grade-by-rung/class exposure). m3 grading read path bounds → **folded** (§5.5 streamed + budgeted).

### Round 1 — internal: INTEGRATION (8 MATERIAL, 3 minor; 1 explicit PASS)
A1 JP log constructed only in mesh block → **folded**: FD9 unconditional construction (named deliverable).
A2 outcome stranding on topic transfer → **folded**: FD10 honest-degradation + orphanOutcomes +
  machineId-prefixed ids; routing tracked (ACT-1199).
A3 machine-coherence "participates like sibling flags" factually wrong → **folded**: §5.7
  COHERENCE_MANIFEST_EXCLUSIONS row deliverable.
A4 operator-ratified-exception citation — **verified PASS** (registry:522 pins the containment posture;
  SHA resolvable; lint contract satisfied).
A5 pool merge semantics → **folded**: machine-tagged rows + hygiene.
B1 zero migration-parity/agent-awareness coverage → **folded**: new spec section.
C1 rollback/verdict_id retention semantics → **folded**: §5.7 (always-on minting rationale, expired
  honesty, seam-off semantics).
D1 dashboard follow-up untracked → **folded**: ACT-1197 minted; FD13.
E2 FD6 posture conflated registries → **folded**: exact DEV_GATED_FEATURES language + seeded-false trap
  note.
E3 testing section → **folded**.
minors (job-never-messages pin; registry-heading citation; pool hygiene) → **folded**.

### Round 1 — internal: DECISION-COMPLETENESS (6 MATERIAL, 4 minor; counts FD=6, cheap=3, contested-cleared=2)
M1 id return path → **folded** (§5.1.4). M2 verdict_id collision → **folded** (FD8). M3 JP construction
  gating → **folded** (FD9). M4 first-customer write path (seam vs direct; enacted disposition unknowable
  at call completion) → **folded** (§5.3 one-shape rule). M5 annotation triggers + id persistence
  (in-memory last-16 dies with process) → **folded** (§5.3 durable carriers + operator-reversal OUT).
M6 join locus (ledger asserted to read data it doesn't hold) → **folded** (§5.5 substrate).
m1 field mapping → **folded** (§5.1.5 'unclassified', context head 300). m2 error/shed rows → **folded**
  (errored-settlement row). m3 route dark posture/contract → **folded** (§5.5). m4 dry-run log content →
  **folded** (§5.2 metadata-only).

### Round 1 — internal: LESSONS-AWARE (8 MATERIAL, 4 minor)
M1 parent standard's bench-feed clause silently dropped → **folded**: FD12 explicit tracked deferral
  (ACT-1198) naming the clause.
M2 volume at retrofit scale (measured 4,098 calls/24h) → **folded**: FD4 volume classes.
M3 doom-loop read shape → **folded**: §5.5 substrate + streamed-reader constraint on every new reader.
M4 14-day horizon can't answer a weeks-to-months question → **folded**: 90d rollup (spend_token_rollup
  prior art).
M5 "no new schema" contradiction → **folded**: §5.2 named additive fields.
M6 census rot (WIRING_EXCLUSIONS lesson) → **folded**: closed exemption taxonomy + census debt on the
  route.
M7 retrofit changes what contextRedacted exposes (posture ratified for admission metadata) → **folded**:
  content classes.
M8 test plan + two test lessons (verdict_id NULL-world pinned tests; wall-clock coupling) → **folded**:
  Testing section (sweep + injected clocks).
m findings (grading convergence semantics; durable id carry; seam CPU budget sentence) → **folded**.
Conformance flag 1 resolved-stale empirically (worktree parser run: 74 articles incl. the standard).
Feedback-memory disclosure: no feedback_*.md files exist on this agent; session-memory lessons engaged.

### Round 2 — Standards-Conformance Gate (1 flag)
1. **Operator-Surface Quality** — API-only route for an operator decision surface. *(Judgment pending:
   handed to round-2 integration + lessons reviewers; FD13 tracks the dashboard deferral.)*

### Round 2 — external: codex-cli:gpt-5.5 (verdict MINOR ISSUES)
*(disposition pending round-2 fold)*
1. Decision boundary for multi-call judges (one decision spanning multiple evaluate() calls).
2. Rollup late-arrival/regrade mutation semantics unstated.
3. Grades risk judging the pipeline, not the LLM recommendation (floor-veto/governor-hold cases).
4. Grep-level 'wired' verification weak (dead-code satisfiable) — typed registration preferred.
5. Content-class envelopes operationally subjective — per-class builders/validators.
6. (caveat) reviewer context truncated for JudgmentProvenanceLog.ts — disclosure.

### Round 2 — external: gemini-cli:gemini-3.1-pro-preview (verdict MINOR ISSUES)
*(disposition pending round-2 fold)*
1. Glossary/exec summary for external readers.
2. ACT-1199 (cross-machine outcome routing) priority nudge — sustained orphan blind spot on
   multi-machine fleets.
3. Content-bearing truncation may drop the salient "why" — prefer code-derived feature extraction.


### Round 2 — internal: SECURITY (3 MATERIAL; all 8 r1 resolutions verified genuine)
M1 breaker floor behavior on inbound id unspecified → **folded**: §5.1.2 unmarked-id discard + b- re-mint.
M2 provenance strip router-only; breaker spreads options into adapters on bypass path → **folded**: §5.1.6
  strip at BOTH seams.
M3 optionsPresented/verdict_class caller-authored, served unscrubbed → **folded**: §5.2 static enum-like
  labels, charset/length clamp, violation → 'unclassified' + counted.

### Round 2 — internal: SCALABILITY (4 MATERIAL, 4 minor; all r1 resolutions genuine)
M1 settled-attempt usage/model capture — naive last-write-wins mislabels (onUsage fires on rejects; late
  callbacks from abandoned attempts) → **folded**: §5.1.5 per-attempt capture scoping.
M2 rollup aggregates mutable facts with no maintenance/repair semantics → **folded**: §5.5 decision-day
  bucket recompute + boot/periodic reconcile.
M3 "async-buffered" false for the SQLite half → **folded**: Testing perf scope split (JSONL async;
  decision_quality sync WAL ≤1/decision).
M4 onCorrelationId vs dropped decisions → **folded**: decision_quality row written for EVERY enrolled
  settlement; volume class valves the JSONL row only.
minors (keyset cursor; wired-but-silent granularity; prune path; index names) → **folded**.

### Round 2 — internal: ADVERSARIAL (8 MATERIAL, 3 non-material notes; architecture confirmed genuine)
M1 mintedBy:'breaker' had no storage location → **folded**: b-/d- id prefix split, derivable from the id.
M2 rung claims self-declared; within-rung conflicts unresolved → **folded**: ruleId→rung registry +
  conservative within-rung order.
M3 three evaluate() exits never enter the ladder → **folded**: settlement = every exit + degrade/no-cfg
  unit cases.
M4 hog respawn predicates ungradeable (owner identity not recorded; commandHash strips parentPid) →
  **folded**: owner tuple (parentPid+startTime) recorded in decision context.
M5 leave-recurrence attributes breaker/governor holds + legitimate spares to the classifier → **folded**:
  enacted + floorPermitted preconditions; slot semantics stated.
M6 rollup/read semantics under late/superseding/absent evidence → **folded** (with DC/SCAL — bucket,
  decrement, expired read-derived, joinMiss split expired vs not-written).
M7 wired-but-silent underspecified (N, granularity) → **folded**: wiredSilentMinCalls=20 + 1:1 component
  key convention + honest low-traffic bound.
M8 exemption claims never cross-checked → **folded**: exempt-but-active flag.
notes (one-decision-per-invocation stated; pending-ACT honesty; rollup-horizon phrasing) → **folded**.

### Round 2 — internal: INTEGRATION (3 MATERIAL; all 8 r1 resolutions verified genuine; FD13 judged
adequate — Operator-Surface Quality binds at the tracked dashboard follow-up, one interim-surface
sentence added)
M1 hog carrier claimed durable but in-memory/kills-only/1h — → **folded**: §5.3 named new durable store
  deliverable.
M2 verdict_id single-writer falsified by event-kind rows → **folded**: FD8 scoped to kind:'llm'.
M3 cannot-leak overclaim on bypass path → **folded**: funnel-wrapper strip (with SEC M2).
minors (migration enumeration completeness; exclusions row voluntary-not-swept note; grade-pass shape)
  → **folded**.

### Round 2 — internal: DECISION-COMPLETENESS (3 MATERIAL, 5 minor; 5.5/6 r1 gaps verified closed)
M1 hog carrier false code anchor (the decisive version of INT M1, with the 1h-retention and
  leave-writes-nothing evidence) → **folded**: §5.3 store design incl. retention-derives-from-window.
M2 rollup bucket attribution + expired lifecycle self-contradiction → **folded**: decision-UTC-day
  bucket; expired dropped from rollup columns, read-derived; one terminal label.
M3 onCorrelationId firing point → **folded**: fires at MINT, synchronously, incl. throw paths.
minors (table ownership/singleton; wiredSilentMinCalls; UTC-day budget; grade-pass contract; immutable
  ruleIds) → **folded**.

### Round 2 — internal: LESSONS-AWARE (5 MATERIAL, 4 minor; r1 folds verified honest; conformance
Operator-Surface flag judged NOT material — read surface has no authorize/decide/act flow)
M1 hog carrier fiction (strongest statement of the shared finding) → **folded**: §5.3.
M2 no prune path for the 3 new tables on a per-table-prune host → **folded**: named retention keys +
  prune methods + timer wiring.
M3 substrate drops the attribution dimensions of the operator question → **folded**: model/framework/
  prompt_id columns on decision_quality at 90d.
M4 pending:<ACT> format-only while WIRING_EXCLUSIONS-style rot looms → **folded**: liveness-checked ACT
  refs + pinned/critical ACTs.
M5 router→substrate injection seam unstated → **folded**: setDecisionQualityRecorder singleton.
minors (callerRef location; granularity; P19 regrade test; anchor cite) → **folded**.

### Round 2 — external: codex (disposition)
1 decision boundary → **folded** (§5.1.1 one-row-per-invocation + census composition field).
2 rollup late-arrival semantics → **folded** (§5.5 mutation rules).
3 pipeline-vs-LLM-verdict grading → **folded** (§5.3 grades-attribute-to-verdict + rule preconditions).
4 grep-wired weak → **folded** (typed census registration; grep demoted to backstop).
5 envelope subjectivity → **folded** (per-class envelope builders).
6 context caveat → disclosure only.

### Round 2 — external: gemini (disposition)
1 glossary → ELI16 companion updated (accessibility surface).
2 ACT-1199 priority nudge → RECORDED AS ADVISORY DISSENT (operator call; orphanOutcomes visibility is
  the honest mitigant this build).
3 content-bearing truncation → **folded** (§5.2 feature-extraction preference for high-stakes points).

### Round 3 — Standards-Conformance Gate (ZERO flags; 3 → 1 → 0 across rounds)

### Round 3 — external: codex-cli:gpt-5.5 (verdict MINOR ISSUES — "no serious architectural blocker")
5 refinements, all **folded** into v4: kind-scoped verdict_id queries pinned by lint (CX3-1);
evidence-strength classes per rule so proof-like vs heuristic grades are never conflated (CX3-2);
runtime coverage keyed on decision-point id with the component-key bridge stated honestly (CX3-3);
bounded per-ledgerKey history — latest slot + in-window kill retention (CX3-4); graduation checklist
with expected counters per phase (CX3-5).

### Round 3 — external: gemini (DEGRADED — timeout; recorded per-round, aggregate stays clean RAN)

### Round 3 — internal: SCALABILITY (PASS, 0 material — all r2 fixes verified landed with accurate anchors)

### Round 3 — internal: SECURITY (3 MATERIAL; all r2 folds verified genuine)
SEC3-1 hog store dashboard-servable/editable by default → **folded** (NEVER_SERVED + gitignore/backup
parity + serve-discipline tests). SEC3-2 promptId escapes the §5.2 clamp → **folded** (clamp extended).
SEC3-3 mint marker lands on the caller's options object — reused-object replay → **folded**
(router-internal clone + single-use marker consumption + reuse test).

### Round 3 — internal: INTEGRATION (4 MATERIAL; all r2 folds + ~30 anchors verified genuine)
INT3-F1 pending-ACT liveness cannot run in repo CI → **folded** (honest split: CI = static format/
pinned checks; liveness = agent-side census-debt on the route, pending-ref-dead flags). INT3-F2 hog
store root placement would ride a git-synced path → **folded** (moved under .instar/state/, combined
with SEC3-1). INT3-F3 reconcile/prune wiring point unnamed → **folded** (6h timer + construction-
condition quality arm). INT3-F4 ruleId→rung registry home unnamed → **folded** (co-located with
PROVENANCE_COVERAGE in src/data).

### Round 3 — internal: LESSONS-AWARE (2 MATERIAL; all r2 folds + parent-standard obligations verified)
LES3-M1 enacted enum incomplete vs the sentinel's real disposition space → **folded** (10-value enum;
only killed/sigterm-exited enter kill-grading; watch-only soak honesty stated). LES3-M2 pending-ACT
liveness CI-resolvability asserted-not-designed (= INT3-F1, independent convergence) → **folded**.
Minors (prune-timer condition; cite fixes; at-rest clause; identity+features honesty sentence) →
**folded**.

### Round 3 — internal: ADVERSARIAL (5 MATERIAL; all 8 r2 folds genuine; stall + revival recorded)
ADV3-1 ownerTuple unpopulatable in the dominant orphan case / impostor tuple → **folded** (targetTuple
= the killed process's OWN pid+start-time; spoof-proof kill-time ordering re-test). ADV3-2 latest-slot
evicts the decision it should grade → **folded** (grade-on-supersede + in-window kill slot retention).
ADV3-3 pending-ACT liveness (3rd independent convergence) → **folded**. ADV3-4 leave-recurrence
gradeable on fabricated same-hash evidence → **folded** (recurrence keyed on the SAME process
signature; different process → unknown). ADV3-5 sustained-right sensor overclaim → **folded**
(negative-evidence bound stated; candidate-visibility named).

### Round 3 — internal: DECISION-COMPLETENESS (2 MATERIAL + minors; stall + fresh re-run BOTH recorded)
DC3-M1 grade-on-supersede within-tick ordering (= ADV3-2) → **folded**. DC3-M2 window-close grading vs
prune race → **folded** (retention = evidenceWindow + gradingSlack ≥ 2× job cadence; hourly cron
named). Minors (4th grading-cursor table + backoff columns; machineId8 source; 6h reconcile host;
dryRun suppresses ALL durable writes; registry home; window-change mints -v2; cite fixes) → **folded**.

### Round 4 — confirmation round on v4 (verdict: NOT clean — 2 MATERIAL + 3 codex one-sentence folds)
Conformance gate: 1 flag = the KNOWN stale-checker traceability artifact (deployed dist predates the
registry merge; empirically resolved-stale in r1). codex r4: MINOR ISSUES — CX4-1 dedicated-column
re-argument → rationale sentence folded; CX4-2 strength-first default view → folded; CX4-3 adapter
seam = the rule registry (note); CX4-4 census-bureaucracy dissent → recorded; CX4-5 dryRun-staging
honesty clause → folded. gemini r4: DEGRADED (timeout, 2nd consecutive). SCALABILITY: PASS.
DECISION-COMPLETENESS: PASS — "CONVERGED at round 4", 7/7 r3 folds line-verified, 7 candidates
contested-then-cleared, 0 cheap tags remaining. ADVERSARIAL: 1 MATERIAL — ADV4-1 ownerTuple schema
said "recorded as absent" in the parent-absent case while parseParentPid provably succeeds for every
permitted kill → **folded into v5** (member-wise recording: parentPid ALWAYS on kills,
parentStartTime where-derivable; both bad implementer exits closed). SECURITY: 1 MATERIAL — SEC4-1
NEVER_SERVED_PREFIXES is projectDir-rooted so a 'state/...' literal is a production NO-OP, and the
EXISTING 'state/judgment-provenance/' entry is itself misrooted (a LIVE pre-existing defect: JP
contextFull day-files reachable by the dashboard file editor TODAY; tracked ACT-1200) → **folded into
v5** (projectDir-relative literal pinned; JP entry dual-rooted/fixed in the same PR; tests pinned to
the PRODUCTION layout). INTEGRATION + LESSONS-AWARE: NO VERDICT — both reviewer sessions killed by a
host session respawn before filing; NOT counted as passes, both re-run fresh in round 5.

### Round 5 — confirmation round on v5 (verdict: NOT clean — 1 MATERIAL + one-clause minors)
Conformance gate: 2 flags, both known artifacts (stale-checker traceability; Operator-Surface Quality
disposed r2 via FD13/ACT-1197 — integration confirmed the disposition NOT eroded, do-not-re-flag).
codex r5: MINOR ISSUES — CX5-2 insufficient-evidence marker below a minimum sample **folded**; CX5-1/
3/4/5 re-arguments/already-required → dissents recorded. gemini r5: DEGRADED (timeout, 3rd
consecutive; aggregate stays clean RAN via codex 5/5). SCALABILITY: PASS 0/0 (fresh code-grounded
sweep clean). DECISION-COMPLETENESS: PASS — convergence re-affirmed on v5 (0 cheap tags, 0 open
questions, FD1–FD13 complete). SECURITY: PASS 0 material — SEC4-1 fold verified genuine in all three
parts with empirical grounding; 2 one-clause minors **folded** (onCorrelationId try/catch containment;
hog-store backup exclusion must be an ACTIVE entry). INTEGRATION: PASS 0 material — independently
REPLICATED the SEC4-1 live defect against deployed code; Standard A/B, migration parity, rollback all
clean; 3 minors **folded** (active backup-exclusion entry — converged with security; CapabilityIndex
/judgment-provenance text goes stale under FD9, same-PR update; cosmetic anchor drift re-grounded).
LESSONS-AWARE: PASS 0/0 CLEAN — all r3/r4 folds line-verified; both conformance flags disposed
empirically (registry:522/523 carries the parent standard; FD12 citation exact); foundation audit one
layer below found every foundation defect surfaced in-spec with same-PR fix or tracked ACT.
ADVERSARIAL: 1 MATERIAL — ADV5-1: census discovery is COMPONENT-keyed while declarations are per
DECISION POINT, so a second judgment reusing a declared sibling's attribution key silently skips every
guard layer (CI clean via the sibling's entry; wired-but-silent quiet via the sibling's rows; the
settlement census check fires only on enrollment) → **folded into v6**: the 1:1 key convention becomes
a census-test ASSERTION (unique key per wired point — reuse is lint-visible at declare/enroll) and the
one undetectable case (an unenrolled, undeclared same-key point) is NAMED as a review-caught residual.
4 adversarial minors **folded** (rung-registry owning-component binding; parentPid guarantee scoped to
ENACTED kills; exempt baseline pinned shrink-only; grade-pass fairness honesty + per-point sub-budget
trigger at third enrollment). Non-landed attacks recorded (commandHash-collision fabrication,
store-flood, impostor parentStartTime, stale-marker replay, legacy row-id path, run-state tampering).

### Round 6 — confirmation round on v6 (verdict: NOT clean — 1 shared MATERIAL, five-way convergence)
Conformance gate: the 2 known artifacts, nothing new. codex: MINOR (2 editorial folds + dissents).
gemini: DEGRADED (timeout, 4th consecutive). SCALABILITY: PASS 0/0 (independent v5→v6 diff
verification — exactly the ten claimed deltas). The material: FIVE reviewers (SEC, DC, LES, INT, ADV
— ADV independently, before seeing the others' verdicts) each ground-truthed that the round-5
backup-exclusion fold pinned the WRONG BackupManager constant — the remediation-flag-gated list
(inert on default agents) instead of the unconditional NEVER_BACKUP_PATH_SEGMENTS that actually
excludes the JP dir — i.e. the SEC4-1 "guard that is a production no-op" class reproduced INSIDE a
fold, caught by the confirmation machinery checking the folds themselves. Integration honestly traced
the mis-pin's origin to its own round-5 finding text. Security's deeper grounding also exposed the
pre-existing directory-copy per-file bypass (ACT-1201) affecting existing protected state files.
Adversarial added the invariant extension (the JP dir's current safety is a non-recursive-copy
ACCIDENT) + 3 minors (multi-call key contradiction; permitted≠enacted wording; served rejection
counters) — all folded into v7 alongside the converged backup fix.

### Round 7 — confirmation round on v7 (verdict: CLEAN — CONVERGED)
Conformance gate: ZERO flags. Externals: BOTH families ran — codex MINOR (glossary, canonical
winning-grade pin, deprecation trigger, re-arguments), gemini MINOR (glossary, two
architecture-alternative dissents, decision-recorded) — the confirmation round itself carried full
dual-family external coverage. Internals, all six PASS at material level with every round-6 fold
verified genuine against code: SCALABILITY 0/0 (5th consecutive; per-file re-check costed <1% of the
copy loop it rides); SECURITY 0/0 (full walk-through of the corrected backup fix; per-file re-check
verified LOAD-BEARING, not decorative; 2 minors on pre-existing adjacent defects — the BLOCKED_FILES
config.json case + the doubly-inert remediation list); DECISION-COMPLETENESS 0/0 (converged
re-affirmed; FD=13, open-user-decisions=0); INTEGRATION 0/0 (fold verified genuine AND buildable;
live threat replication; restore-path + pending-inbound scope adds); LESSONS-AWARE 0/0 (full
P1-P23/L1-L17/B1-B39 sweep clean; ELI16-currency minor); ADVERSARIAL 0/0 (all prior folds line-
verified; non-landed attacks recorded: tmp-sibling smuggling, path-traversal spellings, restore-side
reintroduction, assertion gaming). All round-7 minors were folded editorially into the converged
text (v8) — none were material, none blocked convergence.


## Convergence verdict

**CONVERGED at round 7.** Both additive criteria hold: (1) the round-7 confirmation produced ZERO
material findings across six internal perspectives, two external model families, and the zero-flag
constitutional gate — every prior round's fold verified genuine against the worktree code by multiple
independent reviewers; (2) zero unresolved user-decisions remain (`## Open questions` empty; 13
Frontloaded Decisions; 1 surviving cheap-to-change-after tag, contested and cleared).

Honest characterization of the path: rounds 1–3 were design rounds (~40, 26, and 16 materials — each
independently verified folded-genuine in the following round); rounds 4–6 were attempted confirmation
rounds that each found real material (2 / 1 / 1) and were folded rather than argued away — including
the round-6 five-reviewer catch of a defect in the review's OWN round-5 fold, and the round-5 catch
of a LIVE pre-existing production defect (ACT-1200) plus round 6's second one (ACT-1201). Round 7 is
the clean confirmation. Externals: codex-cli:gpt-5.5 ran all 7 rounds; gemini ran rounds 1, 2, and 7
(timeouts r3–r6 recorded per-round). Internal reviewers ran on claude-fable-5 (D7 disclosure,
per-round model recorded in the ledger).

Two live pre-existing production defects were discovered and durably tracked as side effects of this
review (ACT-1200: JP provenance log servable+editable via the dashboard file editor; ACT-1201:
BackupManager directory-copy per-file exclusion bypass) — both fixed in this build's PR.
