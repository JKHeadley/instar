---
title: "Operator Pushback as Honest Improvement Data"
slug: "operator-pushback-improvement-data"
author: "Instar-codey"
eli16-overview: "operator-pushback-improvement-data.eli16.md"
status: draft
approved: false
ships-staged: true
parent-principle: "Truth Over Fluency"
lessons-engaged: "P1,P2,P4,P5,P7,P9,P10,P18,P19,P20,P21,L3,L5,L6,L9,L11,L15,B14,B20,B22,B24,B28,B30,B39"
review-convergence: "2026-07-23T07:24:00.000Z"
review-iterations: 3
review-completed-at: "2026-07-23T07:24:00.000Z"
review-report: "docs/specs/reports/operator-pushback-improvement-data-convergence.md"
cross-model-review: "codex-multi-agent"
single-run-completable: true
frontloaded-decisions: 14
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Operator Pushback as Honest Improvement Data

## Problem statement

When an operator says “that is wrong,” “do it yourself,” “I already told you,”
or “stop asking me that,” the moment is valuable evidence. Today some of these
moments enter the Correction and Preference Learning loop, some enter the
human-as-detector heat map, and premature deferral is separately recognized in
tone-gate provenance. The evidence is fragmented, and the relationship to
decision-quality and benchmark measurement is not defined.

The tempting shortcut is unsound: detect an objection, call the agent wrong,
and turn it into a benchmark grade. The same operator sentence would then be
detector, label, and oracle. That repeats the exact circularity rejected for
tone-gate grading. “The operator pushed back” and “the agent was wrong” are
different propositions.

This specification extends the existing correction, provenance,
decision-quality, and benchmark-divergence surfaces. It creates no parallel
pushback store, provenance reader, outcome writer, or prediction mirror.

This PR is **design only**. It changes no runtime behavior, configuration,
schema, routing, grading, preference, benchmark, or authority.

## Goals and non-goals

Goals:

- preserve every *recognized authenticated* operator-pushback event as bounded,
  structured improvement evidence;
- classify pushback honestly, using deterministic rules where the evidence is
  structural and `unknown` where it is not;
- keep raw conversation out of durable measurement data;
- extend `/corrections` as the canonical observation and learning lifecycle;
- connect only independently verified outcomes to the existing
  decision-quality annotation chokepoint;
- define a separate reviewed path from eligible evidence to a reproducible
  benchmark case;
- report detection coverage and ambiguity instead of claiming exhaustive
  capture;
- ship every implementation phase dark and dry-run-first.

Non-goals:

- treating disagreement, recurrence, confidence, apology, or silence as truth;
- ranking operators, optimizing agents for lower pushback, or rewarding
  agreement;
- weakening safety or authorization gates because an operator objected;
- storing raw messages, quotes, model rationales, screenshots, URLs, or
  credential-bearing context;
- making `benchmarkPredictions.json` a case store;
- automatically admitting cases to a benchmark battery;
- applying preferences or changing prompts in this design-only increment.

## Existing surfaces and extension decision

| Existing surface | Canonical responsibility | ACT-898 extension |
|---|---|---|
| `detectDeferralShape()` + tone-gate `deferralShapeDetected` | Deterministically recognizes one outbound agent behavior: premature deferral. | Feeder/candidate only. A later authenticated operator correction must be causally linked through conversation lineage. Time or hash proximity alone is forbidden. |
| `JudgmentProvenanceLog.readDeferralPatternObservations()` | The sole typed reader over canonical tone-gate provenance. | Reused unchanged. No second JSONL parser or store. |
| `HumanAsDetectorLog.classify()` | Deterministic inbound candidate recognition and guardian heat-map categories. | Gains a closed, versioned pushback projection while preserving the existing guardian-vs-learning category split. It nominates candidates; lexical matches do not prove correctness. |
| `CorrectionCaptureLoop` | Existing bounded context capture, pre/post scrub, distillation, and retry path. | Carries the closed pushback envelope through the same ingress and scrub path. No second observer or backlog. |
| `CorrectionLedger` + `/corrections` | Canonical scrubbed correction/preference records, occurrences, recurrence, lifecycle, and served view. | Gains additive per-occurrence pushback provenance and content-free evidence state in the same database/transaction. No `PushbackLedger`. |
| `DecisionQualityRecorderImpl.annotateDecisionOutcome()` | Sole registered, correlation-bound outcome annotation chokepoint. | Receives a grade only when an independent registered evidence rule qualifies it. Otherwise the pushback remains ungraded. |
| `BenchmarkDivergenceAnalyzer` and prediction mirror | Compares genuine production outcome grades with an existing benchmark baseline. | Never ingests cases or raw pushback rates. It consumes the normal meter only after legitimate grading and benchmark admission. |

The Correction Ledger remains the source of truth for correction observations.
The judgment-provenance log remains the source of truth for the outbound
deferral candidate. The decision-quality ledger remains the source of truth for
verified outcomes. Each pointer crosses a boundary; no surface absorbs another
surface’s authority.

## Unit of observation and authenticated ingress

An `ObservedPushbackV1` exists only when all of these hold:

1. the event is an authenticated inbound message or explicit UI disposition;
2. the principal and role are resolved from the adapter’s authenticated
   envelope, not from message prose or `fromUser: true`;
3. the principal is authorized for the scoped conversation/project;
4. the event is not bot-authored, forwarded third-party speech, quoted agent
   output, a tool result, or an agent echo;
5. a deterministic rule or bounded taxonomy classifier nominates pushback.

The contract promises complete handling of recognized authenticated events,
not perfect natural-language recall. Unclassified samples, `unknown` results,
and adapter coverage gaps are first-class status counters.

ACT-896’s deferral boolean describes the agent’s outbound candidate. It becomes
part of an operator-pushback observation only through an explicit causal join:
the inbound correction references the immediately preceding candidate within
the same authenticated conversation lineage, or carries a durable
correlation/message-reply pointer. A candidate hash, topic match, or time
window alone may not establish causality.

## Pushback taxonomy

Classification has two orthogonal fields: a primary `pushbackClass` and zero or
more closed `subjects`. One recognition event is retained even when its class
is `unknown`.

### Primary classes

| Class | Meaning | Recognition posture | Correctness implication |
|---|---|---|---|
| `explicit-preference` | Operator states a desired style or workflow. | Deterministic only for high-precision prospective forms; otherwise judgment-candidate. | Authoritative about that operator’s preference prospectively, never proof a factual claim was wrong. |
| `execution-ownership` | Agent wrongly hands work back, asks for unnecessary action, or avoids ownership. | Deterministic when a verified deferral candidate is causally joined to explicit pushback; otherwise judgment-candidate. | Ungraded until a prior contract or independent execution evidence exists. |
| `scope-intent` | Wrong task, target, priority, or interpretation. | Reply/target lineage plus closed phrase rules; ambiguous target → unknown. | Operator can restate intent, but prior correctness depends on the previously recorded instruction. |
| `factual-technical` | A claim, calculation, diagnosis, or result is alleged wrong. | Candidate only unless an independent fact source settles it. | Never graded from the allegation itself. |
| `evidence-completion` | Operator disputes “done,” “green,” “fixed,” or asks for missing proof. | Deterministic target join to a completion claim; outcome remains separate. | Grade only from test/readback/artifact evidence. |
| `authority-safety` | Agent requested too much/too little authority or crossed a safety boundary. | Structural gate/disposition evidence preferred; otherwise judgment-candidate. | May never auto-relax a guard or grant access. |
| `process-quality` | Method, verbosity, coordination, repeated ask, or UX quality. | Existing preference/frustration/repeat-ask rules nominate. | Usually adherence/quality evidence, not factual correctness. |
| `disagreement-only` | Operator rejects a recommendation or tradeoff without establishing error. | Explicit rejection with linked target. | Always ungraded unless later independent evidence settles the choice. |
| `unknown` | Pushback is apparent but class or target is unsupported. | Required fallback for bare “no,” sarcasm, ambiguous pronouns, quotations, or weak context. | None. |

### Subject labels

Closed labels may include `deferral`, `claim`, `completion`, `scope`,
`authorization`, `credential`, `safety`, `preference`, `style`, `verbosity`,
`evidence`, `coordination`, and `other`. Unknown labels are refused, not stored
as free text.

### Recognition ladder

1. **Structural deterministic:** authenticated UI disposition, reply/correlation
   lineage, gate outcome, or exact machine-verifiable event.
2. **High-precision deterministic phrase candidate:** existing versioned regex
   rules plus authenticated identity and target adjacency. This proves wording,
   not truth.
3. **Judgment-candidate taxonomy:** the existing bounded,
   pre-scrubbed `CorrectionCaptureLoop` may assign class/subject/target under a
   strict enum schema. LLM confidence remains advisory.
4. **Unknown:** any unsupported, conflicting, spoofed, quoted, sarcastic, or
   unlinked case.

Classifier input is untrusted data. The prompt cannot invoke tools, change the
taxonomy, emit grades, admit benchmarks, write preferences, or follow
instructions inside the captured text. Schema escape becomes `unknown`.

## Canonical data path and privacy boundary

```text
authenticated inbound event
  → HumanAsDetectorLog candidate projection
  → existing CorrectionCaptureLoop (bounded window; deterministic pre-scrub)
  → strict taxonomy envelope (post-scrub; enum clamp)
  → existing CorrectionLedger transaction
       correction record + per-occurrence pushback provenance
  → optional content-free evidence projection
       ├─ ungraded decision-quality context/counters
       ├─ independently verified outcome annotation
       └─ separately reviewed benchmark-candidate lifecycle
```

The measurement projection contains no raw or scrubbed summary. “Scrubbed” is
still content-bearing. Existing `scrubbedSummary` remains inside the current
Correction Ledger/API policy; it is not copied into decision-quality, pool
aggregation, benchmark metadata, logs, errors, backups outside the existing
store contract, or model-selection features.

### Content-free per-occurrence envelope

```ts
interface PushbackOccurrenceV1 {
  version: 1;
  observationId: string;              // opaque local id
  correctionRecordId: string;         // canonical ledger pointer
  sourceEventIdHmac: string;           // installation-keyed, adapter-stable
  occurredAt: string;
  sourceMachineId: string;
  principalRole: 'owner' | 'operator' | 'collaborator';
  scopeIdHmac: string;                 // no served topic/user/project id
  pushbackClass: PushbackClassV1;
  subjects: PushbackSubjectV1[];
  recognizerKind: 'deterministic' | 'judgment-candidate' | 'unknown';
  recognizerRuleIds: string[];
  recognizerVersion: string;
  taxonomyVersion: string;
  scrubberVersion: string;
  linkageMethod: 'reply' | 'correlation' | 'adjacent' | 'unlinked';
  targetDecisionPoint?: string;
  targetCorrelationId?: string;
  outboundCandidateSha256?: string;
  evidenceState: 'observed' | 'evidence-attached' | 'independently-verified';
  gradeEligibility: 'ineligible' | 'unknown-only' | 'eligible';
  benchmarkState: 'not-candidate' | 'candidate' | 'reviewed' | 'admitted' | 'rejected';
}
```

Stable global user/message hashes are forbidden. HMACs are installation-scoped,
rotatable, and never served. API projections use opaque ids and cohort counts.
The current `/corrections` topic identifier is not widened into pool/export
surfaces.

Per-occurrence provenance is mandatory because the existing record-level
`max(deterministicWeight)` and `max(llmConfidence)` upsert behavior must not
launder weak occurrences into strong evidence. Grading eligibility is computed
from the qualifying occurrence and its independent evidence, never inherited
from a deduped record maximum.

## Honesty line and evidence ladder

The following rule is invariant:

> Pushback proves that an authenticated operator objected. It does not prove
> that the agent was wrong.

| Level | Evidence | Allowed use |
|---|---|---|
| E0 | Recognized authenticated pushback. | Durable observation, taxonomy, coverage, recurrence. Grade remains unknown. |
| E1 | Repeated pushback across bounded distinct contexts/days. | Pattern/improvement priority. Still not truth. |
| E2 | Prospective operator preference, or a pre-existing versioned instruction contract. | Save the prospective preference through the existing reviewed path. A later violation of the pre-existing contract may be eligible for adherence grading; no retroactive factual grade. |
| E3 | Independent deterministic evidence: test, readback, artifact state, policy predicate, machine result, or externally settled outcome. | Registered decision-quality rule may annotate right/wrong/unknown through the canonical chokepoint. |
| E4 | Independent authorized adjudication under a pinned rubric over a scrubbed evidence package. | Eligible outcome if adjudicator provenance is causally distinct from the pushback and classifier. |
| E5 | Reproducible, privacy-reviewed case with independently authored expected outcome/rubric and held-out evaluation. | Eligible for reviewed benchmark admission. |

Forbidden evidence includes the same operator utterance, operator insistence,
agent apology/concession, revised-answer acceptance, recurrence, silence,
classifier confidence, another model’s unsupported opinion, or lower future
pushback rate. The capture source, taxonomy classifier, and grade oracle must
not be the same causal source.

When correlation exists but evidence does not mature, a registered rule may
terminalize the outcome as `unknown`, following the existing
`tone-window-unknown-v1` precedent. It may not manufacture `right` or `wrong`.

## Measurement wiring

### Correction and preference learning

Every observation remains in the canonical Correction Ledger lifecycle.
Recurrence may prioritize a learning, preference review, feedback proposal, or
investigation under its existing gates. Recurrence never creates a grade.

Principal scope is binding: a collaborator’s preference does not become the
owner’s preference; one project’s process correction does not become an
organization-wide standard without the existing reviewed promotion path.

### Decision quality

Ungraded pushback may contribute content-free coverage counters beside
decision-quality:

- observations by class and recognition kind;
- linked vs unlinked target rate;
- unknown and classifier-disagreement rates;
- independently verified share;
- evidence-maturity lag;
- per-decision-point exposure denominator.

It does not enter `right_count`, `wrong_count`, `realGradeRate`, or model
selection. At E3+, an immutable rule is registered in `RULE_REGISTRY`, the
underlying decision is enrolled through the existing settlement correlation
spine, and the outcome is written only through
`annotateDecisionOutcome()`. Direct ledger outcome writes are forbidden.

### Benchmark cases and divergence

A content-free observation is not a runnable benchmark case. Promotion is a
separate reviewable lifecycle:

```text
observed
  → evidence-attached
  → independently-verified
  → privacy-safe case authored
  → expected outcome/rubric independently reviewed
  → contamination + prompt-parity check
  → explicit admission to off-repo battery
  → normal prediction-mirror refresh
  → normal BenchmarkDivergenceAnalyzer comparison
```

Admission requires a reproducible scenario, decision-point mapping, registered
evidence rule, independent expected result, reviewer provenance, privacy
review, prompt/template identity, and explicit operator-approved or
mandate-authorized battery admission. If replay data cannot be safely authored,
the event remains improvement evidence forever; hashes are never “decoded” or
treated as a case.

Pushback rate is not compared with benchmark pass rate. It is exposure- and
operator-style-confounded and trivially gameable by suppressing disagreement.
Benchmark divergence continues to consume genuine meter grades and existing
bench predictions only.

## Multi-machine and idempotency

The canonical correction record stays machine-local under its current policy.
Content-free occurrence metadata may merge only through an allowlisted pool
projection:

- dedupe key = authenticated adapter event identity HMAC + origin machine;
- duplicate receipt on two machines counts once;
- HLC orders concurrent updates; immutable recognition provenance never
  changes in place;
- conflicting taxonomy becomes `unknown/conflict`, never last-writer-wins;
- raw turns, `learning`, and `scrubbedSummary` never replicate;
- missing peers yield `partial` coverage with per-machine freshness;
- deletion/tombstone propagation removes derived measurement rows and excludes
  the event from later grading/admission;
- no offline peer blocks local retention or rollback.

## Security, retention, and anti-gaming

- Only authenticated direct human principals are eligible; bot, forwarded,
  quoted, and agent-authored content is structurally excluded.
- Every provider-bound turn is deterministically scrubbed before egress and
  every classifier output is scrubbed and enum-clamped before persistence.
- No prompt, cache, trace, error, health response, dashboard, or debug dump may
  retain the captured window.
- Existing correction summaries keep their current protected policy.
  Measurement occurrences default to 90-day retention; benchmark-candidate
  drafts default to 30 days unless explicitly reviewed; admitted battery cases
  follow the battery’s separate retention contract.
- Files/directories retain 0600/0700 discipline. Backup/export eligibility is
  explicit per table; content-free projection may be backed up, captured
  windows and candidate drafts may not.
- A deletion/right-to-forget operation tombstones the canonical correction,
  removes non-admitted derived rows, and opens a review for an admitted case;
  it never silently leaves a preference or benchmark active.
- Raw correction rate, agreement rate, or lower pushback may not reward,
  route, promote, or select a model.
- Exposure denominators, duplicate/rate floors, unknown rates, deterministic
  drift samples, and false-positive reviews make recognizer suppression and
  operator phrase flooding visible.
- Learned preferences cannot rewrite the recognizer or grade their own future
  compliance without a versioned pre-existing contract and independent rule.

## Phased build plan

### Phase 0 — schema and contracts, fully dark

Add types, migration design, enum registries, pure validators, privacy
allowlists, retention contracts, and tests. No construction, reads, writes,
routes, jobs, or boot wiring.

### Phase 1 — deterministic candidate projection, dry-run

Extend the existing inbound classifier and capture envelope. Default dark;
development canary dry-run emits content-free would-record counters only.
Zero durable observation writes.

### Phase 2 — local observation canary

Opt-in local writes to the existing Correction Ledger transaction. No grades,
preferences, feedback proposals, pool sync, benchmark candidates, or notices.
Soak unknown rate, coverage, spoof resistance, dedupe, and privacy.

### Phase 3 — evidence state machine, dry-run

Join observations to existing decision correlations and independent evidence
rules. Produce would-transition counters; all outcomes remain ungraded.

### Phase 4 — decision-quality annotations

Separately promoted. Only E3+ rules write through the canonical annotation
chokepoint. Unknown remains the default. No model routing or reward.

### Phase 5 — benchmark candidate authoring

Separately promoted, human/mandate reviewed, privacy gated, and off by default.
No automatic admission. Prediction mirror and divergence flow remain unchanged.

### Phase 6 — optional automation

Requires a new converged specification. No live self-improvement, prompt
rewrite, model selection, gate relaxation, or benchmark auto-admission is
authorized here.

Every phase has its own dark flag, `dryRun: true` default, zero-write dry-run
test, bounded counters, rollback lever, and soak criteria. Promotion of one
phase does not imply promotion of the next.

## Rollback

Rollback disables readers, writers, jobs, and pool projections for the affected
phase. Additive schema stays inert. Compatible observations remain quarantined
for their retention window; candidate drafts are deleted; no preference,
grade, or benchmark admission survives solely because this feature was once
enabled. Tombstones continue long enough to prevent resurrection after a
multi-machine rollback.

The design-only PR rolls back by reverting its three documentation files. It
has no runtime or data effect.

## Required tests

- authenticated owner/operator vs spoofed `fromUser`, bot, collaborator,
  forwarded, quoted, tool, and agent-authored messages;
- bare “no,” sarcasm, ambiguous pronoun, quoted correction, and third-party
  speech → `unknown`;
- exact deferral reply/correlation joins; hash/time proximity alone refused;
- prompt-injection attempts to emit a grade, widen enums, admit a benchmark,
  change a preference, or invoke a tool → refused/unknown;
- secret scrubbing before provider, persistence, logs, errors, health,
  dashboard, and backup;
- per-occurrence provenance prevents max-confidence/weight laundering;
- same event received on two machines counts once; HLC conflict → unknown;
- principal/project/org scope isolation and pool field allowlist;
- installation-scoped identifiers cannot be linked through served APIs;
- same evidence source cannot detect, classify, and grade;
- pushback, recurrence, apology, acceptance, and LLM confidence alone keep
  grade unknown;
- pre-existing preference compliance vs newly stated preference distinction;
- unvalidated candidates excluded from decision-quality and benchmark mirror;
- direct outcome-ledger write banned; registered-rule chokepoint required;
- retention, deletion, tombstone, backup/export, restart, and rollback;
- dark = zero construction/read/write; dry-run = zero durable writes;
- kill/restart replay converges idempotently;
- exposure denominators and recognizer-drift counters remain bounded;
- all phases independently promotable and reversible.

## Frontloaded decisions

1. Extend `CorrectionLedger`; no parallel pushback store.
2. Reuse the canonical deferral projection; no second provenance reader.
3. Authenticated direct operator ingress is mandatory.
4. Taxonomy is closed and admits `unknown`.
5. ACT-896 is a causal precursor, never user-pushback proof by itself.
6. Per-occurrence provenance prevents dedupe-record evidence laundering.
7. Measurement projection is genuinely content-free; scrubbed summaries stay
   within the current correction policy.
8. Pushback is never a correctness grade.
9. Only causally independent E3+ evidence can produce right/wrong.
10. Decision outcomes use registered rules and the canonical chokepoint.
11. Benchmark authoring/admission is separate and reviewed.
12. Pushback rates never feed benchmark divergence, rewards, or routing.
13. Multi-machine merge is metadata-only, idempotent, partial-aware, and
    tombstone-safe.
14. Every build phase is dark and dry-run-first.

## Open questions

*(none)*
