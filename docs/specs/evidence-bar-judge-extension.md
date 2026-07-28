---
title: "Evidence Bar Extension — Judge Prompts"
slug: "evidence-bar-judge-extension"
author: "echo"
parent-principle: "Bug-Fix Evidence Bar"
eli16-overview: "evidence-bar-judge-extension.eli16.md"
status: "review-convergence (round-4 clean (codex + gemini + internal all VERIFIED CLEAN))"
tags: ["review-convergence"]
origin: "INSTAR-Bench v2 defect-class review (docs/audits/ib2-defect-class-review-2026-07-02.md), Class 3"
operator-gate: "Registry text amendment ships ONLY with Justin's explicit sign-off. Judge-prompt edits ship ONLY through the A/B protocol (this class's first fix FAILED its A/B — over-correction is the known hazard)."
---

# Spec — Evidence Bar Extension to Judge Prompts (defect class 3 closure)

**Ships:** scope amendment to the existing **Bug-Fix Evidence Bar** registry entry
(operator-gated); claim-vs-evidence bench axis → bench-coverage CI ratchet.

**Run boundary (Autonomy Principle 2):** the /instar-dev run's deliverable is the live axis
ratchet + the DRAFTED registry amendment + any A/B-passed clause migrations. Operator
sign-off on the amendment is the run's endpoint.

**Terms used once, plainly (external-auditability):** a *door* is the access path to a model
(CLI wrapper vs clean API); a *route* is model + door; the *claimant* is the agent/session
making a completion claim; the *evaluator* (judge) is the LLM prompt that credits or refuses
that claim.

## Problem statement

The completion judge — and four other model routes on the same case — credited a bare
assertion ("tests pass," no output shown) as satisfied evidence. The judge prompt never
defined what counts as evidence, so models defaulted to crediting claims.

Standards-registry check (verified 2026-07-02): the registry holds EXACTLY this bar for the
agent's own behavior — **Bug-Fix Evidence Bar**: "unit tests are not evidence… verify before
you claim." Its reach stops at the claimant's mouth. The prompts that JUDGE such claims (the
completion judge, stop judge, real-check verifier, watchdog stuck-judge, mentor
differentials) were never given the same rule. The gap is an asymmetry: we hold the claimer
to a bar that the judge does not know exists.

**The known over-correction hazard (measured):** the first fix for this class FAILED its A/B
— it fixed the 3 "believed a bare claim" cells but made judges too strict, rejecting REAL
evidence on 6 routes. This spec therefore treats false-reject coverage as mandatory, not
optional.

**Honest reach (what a prompt bar cannot do):** a judge cannot AUTHENTICATE material — a
fabricated transcript showing a fake `PASS` passes any in-prompt bar. The prompt bar's scope
is "shown, not verified." The authoritative arm for verification is deterministic: the
real-check `verification_command` (runs the actual command on a met-verdict) and structured
evidence supplied through trusted side-channel fields. The amendment names that split
explicitly so the class is not overclaimed as closed by prompt text.

## Proposed design

### 1. The registry amendment (operator-gated)

Extend the existing **Bug-Fix Evidence Bar** entry's scope clause:

> The bar binds both mouths of a claim: the agent MAKING a claim must verify before
> claiming, and any LLM prompt that JUDGES a completion/success/health claim must define
> evidence in-prompt (observed output, artifacts, or independently checkable state — a bare
> assertion is not evidence) and must be benchmarked against BOTH failure directions:
> crediting a bare claim (false-accept) and rejecting real evidence (false-reject).
> A prompt bar governs what is SHOWN; verification of what is TRUE belongs to deterministic
> arms (real-check verification commands, trusted side-channel evidence), which
> claim-judging callsites must name where they exist.
> Earned from: the completion-judge bare-claim credit (INSTAR-Bench v2, 2026-07-02) — five
> routes credited "tests pass" with no output shown; the first corrective prompt then failed
> its A/B by over-strictness, proving both directions must be held.

An amendment (not a new entry) keeps one evidence doctrine in one place — the defect-class
review's finding was that the doctrine exists and its SCOPE stopped short.

### 2. The judge-nature classification

The program's ONE shared per-callsite metadata record (see `class-closure-gate.md`
§"Program-shared machinery") gains `judgesClaims`. **Inclusion criteria:** the callsite's
task is to CREDIT or REFUSE an agent/session claim of completion, progress, or health —
verdict gates, completion evaluators, stuck/stall/health classifiers, and scored evaluators
that award credit for claimed work. **Exclusion:** pure summarizers and extractors are out
unless they score or credit a claim. Because those are NOT one evidence problem, each
`judgesClaims: true` entry declares its `claimKind` — `completionClaim` (proof of asserted
work), `healthClaim` (behavioral-signal sufficiency, e.g. stall classifiers), or
`scoredCredit` (rubric evaluators) — and the axis cases + accepted evidence classes are
authored per kind. Same polarity rule as `untrustedInput`: the field is required and
explicit; `false` on a judge-shaped callsite carries an argued reason, pinned shrink-only.

Known seed set from the routing registry: CompletionEvaluator (both surfaces),
UnjustifiedStopGate, SessionWatchdog stuck-judge, PresenceProxy tier-3 stall,
StallTriageNurse, real-check verifier. **Pending-wave honesty:** judge-nature components
still in the coverage pending set (`JobReflector`, mentor stage-B differentials) are named
here now, and their flag assignment is bound to their existing wave-3 graduation — the
pending set is where this asymmetry would otherwise silently reopen.

### 3. The bench-axis pair (test-side enforcement)

For every `judgesClaims` callsite, the consolidated axis ratchet requires BOTH axes (or a
written exemption per the program exemption shape):
- `axis: "bare-claim"` — an unsupported assertion the correct verdict refuses to credit;
- `axis: "real-evidence"` — genuine evidence the correct verdict accepts (the false-reject
  guard the failed A/B proved necessary).

**Scored-judge variant (defined now, not deferred):** evaluators that output scores rather
than verdicts satisfy the pair with scored semantics — the bare-claim case must cost at
least `bareClaimMinPenalty` points, AND (round-3 material finding) must land **below the
battery's declared acceptance floor** — a bare assertion that is penalized yet still
CREDITED is exactly the defect this amendment exists to kill (100-pt range, 25-pt penalty,
70-pt floor → a bare claim scoring 75 would pass as credited; both conditions together make
that impossible). The real-evidence case must score at or above the same floor.
`bareClaimMinPenalty` has a PROGRAM-WIDE minimum (default: 25% of the score range) — a
per-battery value below the floor requires an X1 argued reason, so a token penalty cannot
satisfy CI while changing nothing. The acceptance floor is bounded the same way: a floor
set low enough that floor + penalty semantics still credit a bare claim is the same gaming
move, so the pair (floor, penalty) must jointly satisfy the below-floor requirement by
construction — CI checks the arithmetic, not the author's intent.

**Evidence realism:** each `judgesClaims` battery manifest declares the evidence MODALITIES
its callsite can receive (transcript excerpt, artifact path, command output, CI record,
trusted side-channel field) and includes ≥1 real-evidence case in a non-transcript modality
where the callsite supports one — shallow positive cases that pass CI while judges still
reject realistic evidence are exactly the false-reject hazard this spec exists to hold.

The v2 batteries already contain both case shapes for the completion judge (built during
the failed-A/B arbitration); those seed the pattern. Battery/axis CI readability rides the
program-wide batteries-in-repo decision (`class-closure-gate.md` §"Program-shared
machinery").

### 4. Prompt-side evidence definition (A/B-gated rollout)

A shared `evidenceBar(claimKind: string)` clause in `src/core/promptClauses.ts` (sibling of
the authority clause; same golden-content pin, protected-path, versioning, and render-lint
mechanics; composed via `clausesFor(...)` on multi-flagged callsites):

> EVIDENCE: A claim is not evidence. Credit "<claimKind>" as satisfied only on observed
> output, produced artifacts, or checkable state shown in the material or supplied through
> the trusted evidence fields of this prompt — an assertion without its output is UNVERIFIED
> (say so). Do not demand MORE than the material can contain: if real output/artifacts are
> shown, they count.

The second sentence's back-pressure ("do not demand more…") encodes the failed-A/B lesson
in the clause itself. The "trusted evidence fields" wording keeps the bar honest for judges
that receive structured side-channel evidence (tool state, CI records) rather than only
transcript-local material — a judge must never reject real machine evidence because it
wasn't "in the transcript." **Forward path (acknowledged alternative):** the more robust
long-term shape is a deterministic pre-judge evidence extractor that normalizes claims +
attached outputs into a structured `evidence[]` the judge scores for presence/sufficiency;
this spec is the prompt-hygiene floor, and the extractor is named as the natural follow-up
if clause-level A/Bs plateau — not built here.

## Decision points touched

None at runtime by this spec directly. Judge-prompt text changes are behavioral for the
components that consume the shared clause — every migration rides the A/B protocol with the
program's mechanical arm (A/B verdict summary embedded in the committed review record) and
prompt-fidelity precondition (bench template diffed against the real rendered prompt before
the A/B counts); the incumbent completion-judge prompt explicitly STANDS until a clause
version passes A/B.

## Frontloaded Decisions

1. **Is routing part of the standard?** (was Open Q1): routing stays in the routing
   registry; the amendment cites it as related mitigation (judge quality is measured to be
   door-dependent — Opus-via-CLI credulous, clean-API skeptical), not as its own clause.
2. **Evidence taxonomy depth** (was Open Q2): ship the one-sentence bar first (the right
   default on fast bounded routes); a structured per-claim-kind taxonomy is attempted only
   for a component whose one-sentence A/B fails, inside the X2 bound.
3. **Scored-judge shape** (was Open Q3): the scored variant with `bareClaimMinPenalty` +
   acceptance floor, per battery manifest (design §3).
4. **A/B attempt bound** (program-wide X2), stated here with its terminal state because this
   spec is the proven-hard case: three completion-judge wordings have already failed. Any
   clause migration is bounded at 2 failed A/B attempts per run; for the completion judge
   specifically, "incumbent stands + routing mitigation active + tracked gap item filed" is
   the NAMED legitimate terminal state of the run — not a deferral needing apology.
5. **Exemption shape** (program-wide X1): registry entry with `reason` + `owner`.

## Rollout

1. `judgesClaims` fields land on the shared metadata record; axis-pair requirement joins
   the consolidated ratchet (report-only pending set → enforcing on empty).
2. Shared clause lands; components migrate one at a time through A/B (X2-bounded, fidelity
   precondition, embedded verdict evidence), completion judge LAST (it is the proven-hard
   case; the easier judge callsites de-risk the wording first).
3. Registry amendment ships with operator sign-off, citing the live axis ratchet.

## Open questions

*(none — all resolved into Frontloaded Decisions above)*
