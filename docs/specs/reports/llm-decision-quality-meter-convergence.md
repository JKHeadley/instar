# Convergence Report — LLM-Decision Quality Meter — uniform provenance + outcome grading

<!-- DRAFT IN PROGRESS — rounds appended as they complete; banner + verdict written at convergence.
     Working ledger: REVIEW-STATE.local.md (worktree-local). -->

## Cross-model review: (pending — written at convergence from aggregateRoundOutcomes)

Per-round record so far:
- Round 1: codex-cli:gpt-5.5 RAN ok (verdict: SERIOUS ISSUES, 6 findings); gemini-cli:gemini-3.1-pro-preview
  RAN ok (verdict: MINOR ISSUES, 4 findings). Anthropic clean-door reviewer: refused
  `no-supported-framework` (config-disabled on this agent) — disclosure only, never a cross-model pass.
- Round 2: codex-cli:gpt-5.5 RAN ok (verdict: MINOR ISSUES, 5 points + 1 context caveat);
  gemini-cli:gemini-3.1-pro-preview RAN ok (verdict: MINOR ISSUES, 3 points).

## ELI10 Overview

*(written at convergence — see also the ELI16 companion `docs/specs/llm-decision-quality-meter.eli16.md`)*

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

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security(6M), scalability(4M), adversarial(8M), integration(8M), decision-completeness(6M), lessons-aware(8M), codex(SERIOUS,~5M), gemini(minor), conformance-gate(3 flags) | ~40 material (heavy overlap; ~12 distinct clusters) | Full rewrite (v2, commit fbc3c06ef): correlation spine redesigned (FD1/FD7/FD8), quality substrate (3 SQLite tables + 90d rollup), volume classes (FD4 amended), outcome write-integrity + evidence-rule predicates, content classes, JP construction unconditional (FD9), cross-machine honesty (FD10), grading deterministic-only (FD11), Migration-parity + Testing sections, census hardening, FD count 6→13, 3 tracked deferrals minted (ACT-1197/1198/1199) |
| 1 | Standards-Conformance Gate: ran (3 flags — parent-standard traceability [resolved: checker staleness, standard verified at registry:522 + parser run extracting 74 articles], maturation-path posture [resolved: FD6 exact DEV_GATED_FEATURES language], testing-integrity [resolved: Testing section added]) | — | — |
| 2 | Standards-Conformance Gate: ran (1 flag — Operator-Surface Quality, API-only; FD13 tracked deferral, judgment handed to reviewers). Externals: codex MINOR (5), gemini MINOR (3). Internals: *(in flight)* | *(pending)* | *(pending)* |

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

<!-- Round 2 internal findings + fold, and subsequent rounds, appended below -->

## Convergence verdict

*(pending)*
