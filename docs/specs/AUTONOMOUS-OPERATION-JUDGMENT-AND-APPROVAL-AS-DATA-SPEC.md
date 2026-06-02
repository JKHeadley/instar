---
title: "Autonomous Operation — The Stop Reason Is the Work, Approval-as-Data, and Constitutional Traceability"
slug: autonomous-operation-judgment-and-approval-as-data
status: approved
approved: true
approver: justin
approved-at: 2026-06-01T18:22:30Z
approval-mode: approved-as-is
review-convergence: 2026-06-01T17:50:38Z
review-iterations: 2
author: echo
created: 2026-06-01
companion-eli16: AUTONOMOUS-OPERATION-JUDGMENT-AND-APPROVAL-AS-DATA-SPEC.eli16.md
parent-principle: "A Wall Is a Hypothesis / Never a False Blocker (Substrate family — the continuation-surface sibling)"
related-principles: "Architectural Agency in the Gap; Close the Loop; Structure beats Willpower; Signal vs Authority"
lessons-engaged:
  - P1   # Structure > Willpower — pick the strongest structural surface (the stop-hook), not the weakest (a message)
  - P2   # Signal vs Authority — auto-approval must route through a full-context authority, not a bare arithmetic gate
  - P3   # Migration Parity — new ToneReviewContext field, config defaults, CLAUDE.md template
  - P4   # Testing Integrity — all three tiers + wiring-integrity + classifier-drift coverage
  - P5   # Agent Awareness — /approvals + traceability semantics into the CLAUDE.md template
  - P7   # LLM-Supervised Execution — the divergence-digest job declares a supervision tier
  - P10  # Comprehensive-First — phases are independently shippable, not recurrence-risking deferrals
  - P11  # A Wall Is a Hypothesis — the feasibility-surface parent
  - P12  # Never a False Blocker — the agency-surface parent
lessons-declined:
  - P8   # UX/Agent Agency — engaged in spirit (graduated, revocable) but not a primary axis; noted
  - P9   # Intent Engineering — approval-as-data IS intent extraction, but no new intent-doc surface added here
spec-class: governance-safety   # NEVER auto-approval-eligible (this spec governs the gates themselves)
approval-note: >
  DRAFT pending Justin's ratification. Authored under the 2026-06-01 directive
  (topic 13481): autonomous mode keeps "failing" because the agent stops for one
  of two excuses — "I need a judgment call" or "I need real engineering" — and
  BOTH must be closed structurally; approval must become tracked data that trends
  toward auto-approval; and (keystone) ALL work must trace to a constitutional
  standard with an indisputable fit, infra-enforced, with a non-fit halting to
  force a constitution review. Revised after an independent lessons-aware
  convergence review (needs-revision → applied R1-R8). Per the directive this is
  drafted to convergence and handed over as a complete reviewable artifact;
  ratification is the async step.
---

# Autonomous Operation — The Stop Reason Is the Work, Approval-as-Data, and Constitutional Traceability

## Problem

Autonomous mode keeps ending early, and the post-mortem is always the same shape:
the agent reaches a point where it *could* keep going but stops, and the stated
reason is one of exactly two:

1. **"I need a judgment call from the operator."**
2. **"This needs real engineering / a careful build — I'll hand it back."**

Justin's diagnosis (2026-06-01, topic 13481, flagged *critical*): **both are
excuses with structural fixes, not legitimate endpoints.**

- The **judgment-call** stop is a symptom of a *missing documented standard*. When
  a decision isn't covered by the standards corpus, the gap is the work: derive
  the standard from existing principles, write it down, proceed under it, and flag
  it for ratification. The *work* never stops; only *ratification* is async.
- The **"real engineering"** stop is, in Justin's words, "definitely more of an
  excuse." The agent has the full capability and infrastructure. Take it as far as
  possible (spec → converge → build → test) and hand over a *complete reviewable
  artifact*, never a request.

This is the **autonomous-stop-surface** application of two principles that already
exist and are already enforced for *outbound messages*: **P11 "A Wall Is a
Hypothesis"** (B16_UNVERIFIED_WALL) and **P12 "Never a False Blocker"**
(B17_FALSE_BLOCKER). Those guard the *message* surface. The uncovered gap is the
*stop* surface — the decision to end an autonomous run.

Second directive: **approval should become data.** Today an approval is a one-shot
"approved" with no memory. Record every approval as *approved-as-is* vs
*approved-with-change*; capture each divergence's *why*; fold recurring divergences
back into the spec-design standards so specs trend toward approved-as-is; track the
ratio per class; and — once a class's ratio holds above a threshold — pilot
auto-approval for that class. End goal (his words): *"extracting my knowledge and
my judgments into infrastructure"* so autonomous operation no longer depends on him.

Third directive (the keystone, 2026-06-01): **all work must trace to a
constitutional standard with an indisputable fit, infra-enforced.** If a piece of
work does not clearly fall under a current constitutional standard, the system
**halts** and forces a fork: *improve the constitution to cover it, or the work is
unconstitutional and does not ship.* This elevates the registry's existing "an
operational standard that can't name a parent principle is a smell" from advice to
a hard, structural gate.

## Goals

1. **P13 — "The Stop Reason Is the Work"**: a constitutional standard that makes an
   autonomous stop for "judgment" or "engineering" a *work item*, not an endpoint —
   enforced at the **strongest** structural surface (the autonomous-stop
   completion-evaluator), with the message gate as a secondary backstop.
2. **Approval-as-Data**: a durable, signed record of every approval decision; per-
   class ratio aggregation; and a gated, authority-checked auto-approval pilot.
3. **Constitutional Traceability**: a hard, infra-enforced gate that every shippable
   work item names a parent constitutional standard with a judged-indisputable fit,
   and routes a non-fit to a constitution-review decision (improve-or-reject).

## Non-Goals

- No safety gate is removed. Required external approvals, genuine value judgments,
  payments/credentials, and verified external limits remain hard stops (the P12
  counterweight). Auto-approval is scoped to spec sign-off for low-risk,
  high-alignment classes — never to safety-class actions, never to this spec's own
  class (`governance-safety`).
- The autonomous skill's duration/emergency-stop mechanics are unchanged.
- The multi-machine robustness work (LAN-optional standard + active-PULL lease
  propagation) is a *sibling* spec; referenced here only as the first proving ground.

## Design

### Part A — P13: "The Stop Reason Is the Work"

**Proposed constitutional entry** (Substrate family, the *continuation-surface*
sibling of *A Wall Is a Hypothesis* and *Never a False Blocker*; single canonical
parent: those two as one family entry). Lands in **both**
`docs/STANDARDS-REGISTRY.md` (Substrate article) **and**
`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (as **P13**) — the conformance gate
reads the registry, the `/spec-converge` lessons-aware reviewer reads the principles
file, so both surfaces must carry it.

> **Rule.** When an autonomous run would stop because "this needs a judgment call"
> or "this needs real engineering," the stop reason is itself the work item, not a
> verdict. A judgment gap is a missing documented standard: derive it from existing
> principles, write it down, proceed under it, flag it for ratification — the work
> continues, only ratification is async. "Real engineering" is not a stop at all:
> the means are in hand, so take it as far as possible and hand over a complete
> reviewable artifact, never a request.
>
> **In practice.** The *continuation-surface* sibling of P11/P12 (which guard the
> *message* surface). The most insidious of the three, because it wears the
> clothing of prudence ("I'd want your judgment") and humility ("this deserves
> careful engineering"). A stop named honestly *after* the inventory — "I derived
> standard X, proceeded, built and tested the slice; the residual decision is
> genuinely yours: here it is as a yes/no" — is legitimate. The failure is stopping
> *without* deriving, building, and reducing the residual to a crisp ratifiable
> question.
>
> **Earned from.** 2026-06-01 (topic 13481): a multi-machine autonomous run stopped
> repeatedly, each time citing "needs your judgment on sequencing" or "needs real
> engineering at the machines," while the means to proceed were in hand. The
> crystallizing instance, not the first — the deferral-shaped cousin of every prior
> early stop.
>
> **Traces to the goal.** Full autonomous operation is the founding aim. An agent
> that converts every uncovered decision into a halt never accumulates the
> standards that would let the next instance proceed — it stays a supervised
> process by habit. Coherence across time means each stop produces *either* a new
> ratifiable standard *or* a built artifact; a stop that produces neither is the
> failure.
>
> **Applied through.** (1) **Primary, structural:** the autonomous-completion
> evaluator (below). (2) Registered as **P13** so the `/spec-converge` reviewer
> flags plans that accept a halt without a derived standard or built artifact.
> (3) **Secondary backstop:** **B18_AUTONOMY_STOP** in `MessagingToneGate`.

**Primary enforcement — the completion evaluator (R1).** The real structural
surface for an autonomous *stop* already exists:
`.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` calls
`POST /autonomous/evaluate-completion` (the same L2/`stopGate.ts` family as
`UnjustifiedStopGate`), which decides whether the run may end and re-injects
"keep working" guidance otherwise. P13's primary enforcement **extends this
evaluator**: when the stop rationale classifies as *judgment-gap* or
*engineering-deferral*, the evaluator requires the turn to have surfaced **either**
a derived-standard proposal **or** a built artifact (PR/commit/spec path) **or** a
genuinely operator-only residual (the P12 human-only set) before it permits the
stop; otherwise it re-injects P13 guidance and the loop continues. This is the
strongest available surface (P1) — it catches a *silent* stop that emits no
message, which the message gate cannot.

**Secondary backstop — B18_AUTONOMY_STOP (R2).** A message-layer sibling to
B15/B16/B17 in `MessagingToneGate`, mirroring their exact shape (a prose rule block
in `buildPrompt` with LITERAL pattern markers, a LEGITIMATE-clauses allowlist, a
citation-precedence line, and a `Severity: favor FALSE-NEGATIVES` line). It holds an
*outbound message that announces ending an autonomous run* citing a
judgment/engineering reason unless the message shows a derived-standard, a built
artifact, or a named operator-only item. Concrete wiring this requires (named so the
build is honest):
  - Add `B18_AUTONOMY_STOP` to the `VALID_RULES` allowlist (`MessagingToneGate.ts`,
    the rule-name set) — without this the gate rejects it as an invented rule.
  - Plumb autonomous context into the gate: thread the existing
    `getHotPathState().autonomousActive` signal (already computed in the server /
    `stopGate.ts`) into `ToneReviewContext` as a new optional `autonomousActive`
    field, set at the `checkOutboundMessage` route callsite. (Migration: additive
    field, default false → existing callers unaffected.) If the signal is absent
    the rule falls back to text-only heuristics like B15.
  - **Citation precedence:** extend the gate's existing `B15 > B16 > B17` ordering
    to `B15 > B16 > B17 > B18` so a context-death stop (B15) is never double-cited
    as an autonomy stop.

### Part B — Approval-as-Data

**B1. Approval event record.** A new append-only, signed store `ApprovalLedger` at
`.instar/state/approval-ledger.jsonl`, mirroring `SessionPoolE2EResultStore` exactly
(a `canonicalApprovalRow()` that defines signature-excluded canonical bytes — the
direct analogue of `canonicalE2ERow()` — so the tamper-reject test has a defined
target; append-only `recordApproval()`; torn-line-tolerant `all()`; `verify()`).
One row per decision:

```
{ specSlug, specClass, decidedAt, approver,
  mode: "approved-as-is" | "approved-with-change" | "rejected",
  divergences: [{ category, summary, why }],   // empty when approved-as-is
  reviewIterations, commitSha, evidenceRef }
```

**Authority over `mode` (R-risk: gameability).** For a *manual* decision the
**operator is the authoritative source** of the `mode` and `divergences` fields —
the agent must not self-classify the operator's intent. Mechanism: the operator's
approval is recorded from the operator-side action (the approve control / an
explicit "approved as-is" vs "approved with changes: …"), and an operator can
**dispute and correct** any row (a correction is itself an appended, signed row;
history preserved). HMAC signing guarantees integrity, not correctness — so the
authoritative-source rule is what prevents ratio inflation.

**B2. Divergence taxonomy.** `missing-principle` · `risk-reduction` ·
`scope-correction` · `efficiency` · `new-information` · `style`. A
`missing-principle` divergence is a *candidate* trigger to propose a new design
principle — **a proposal only**, never auto-merged into the constitution (the
registry amendment loop's operator-ratification step is mandatory; see Part C).

**B3. Ratio + readiness.** `GET /approvals/summary` returns per class: `total`,
`approvedAsIs`, `ratio`, `streak` (consecutive approved-as-is; **reset to 0 by any
`approved-with-change` or `rejected` row**), `autoApprovalEligible`. The route is
read-only and never gates by itself; the ratio *value* is one input the Part-B4
auto-approval path reads.

**B4. Auto-approval pilot (gated, dark, authority-checked) (R4).** Rides the
Graduated Feature Rollout track (`StageAdvancer` family); ships dark; activates per
class only when (a) eligibility holds AND (b) the operator opts the class in
(`approvals.autoApprove.<class> = true`). **Critically, per P2 (Signal vs
Authority), the arithmetic ratio is a *signal*, not the actor.** When eligible+opted-
in, an auto-approval still routes through a **full-context LLM authority** — a final
standards-conformance + coherence check on that specific spec (the same intelligence
class as the Coherence Gate) — which is what actually authorizes the approve. The
ratio gates *whether the authority is consulted for auto-approval*; the authority
makes the call. An independent classifier also re-derives `specClass` (the
self-declared frontmatter class is not trusted for auto-eligibility — R-risk:
mis-classification). Every auto-approval writes an `approver:"auto"` row AND opens a
**Close-the-Loop** review commitment. Auto-approval is **revocable loudly**: a single
operator override of an auto-approved spec resets that class's streak to 0 and
disables auto-approval for the class pending re-qualification. Per-rule/per-class
kill switch is a config flip.

**B5. Feedback loop (the convergence).** A periodic `approval-divergence-digest`
job (`supervision: tier1` — it proposes constitution-adjacent changes, so it is at
minimum Tier-1 LLM-supervised; **off by default**) aggregates recurring
`missing-principle` / `scope-correction` divergences and surfaces them as
**candidate** additions to the spec-design guidance — proposals routed to the
operator, never self-applied. Without this the ledger is mere accounting; with it,
approval converges.

### Part C — Constitutional Traceability (the Indisputable-Fit gate)

Justin's keystone: every shippable work item must trace to a constitutional
standard with an indisputable fit, infra-enforced; a non-fit halts and forces a
constitution review.

**C1. Proposed constitutional entry** (a foundational governance article in
`STANDARDS-REGISTRY.md`):

> **Rule.** No work ships without an indisputable constitutional fit. Every spec
> must name the parent constitutional standard it serves, with a stated fit
> rationale. If no current standard covers the work, the work **halts** and forces
> a fork: amend the constitution to cover it (the registry amendment loop), or
> recognize the work as unconstitutional and do not ship it.
>
> **In practice.** This makes the registry's "an operational standard that can't
> name a parent principle is a smell" a *hard structural gate* rather than advice.
> The fit is *judged*, not merely *asserted* — a hand-wave parent ("this loosely
> relates to coherence") fails the same as no parent. The pause is not a blocker to
> resent; it is the constitution doing its job — either it grows to cover real work,
> or it correctly refuses work that doesn't belong.
>
> **Earned from.** 2026-06-01 (topic 13481): Justin, directing the autonomy-
> governance build — "the work MUST be clearly traced back to one of our
> constitutional standards with an indisputable fit… otherwise we immediately pause
> and review whether the constitution should be improved OR if the work is
> unconstitutional."
>
> **Traces to the goal.** Coherence *is* the founding goal; a self-evolving agent
> whose work isn't anchored to its own constitution evolves incoherently. This gate
> is the structural guarantee that growth stays coherent with the stated self.
>
> **Applied through.** The conformance ship-gate below.

**C2. Infra enforcement (the honest test).** Hardens the **existing** standards-
conformance reviewer (`src/core/reviewers/standards-conformance.ts`,
`POST /spec/conformance-check`, which reads `STANDARDS-REGISTRY.md` — today built but
advisory and not auto-invoked) into a **blocking, auto-invoked** check:
  - **Commit-time (`scripts/instar-dev-precommit.js`) — the STRUCTURAL gate (always-on,
    server-free):** when a spec is in scope, its `parent-principle` frontmatter must be
    PRESENT and RESOLVE to a real article heading in `STANDARDS-REGISTRY.md`. A missing
    or non-resolving parent **blocks the commit** — the "no orphan / no unconstitutional
    work" guarantee, needing no LLM (so it cannot hang a commit and cannot be down). Fails
    OPEN only if the registry itself is unreadable.
  - **Review-time (`POST /spec/conformance-check`) — the QUALITATIVE fit:** the route
    returns a net-new `fit` verdict on `ConformanceReport` (`fit`/`weak`/`none`) from the
    reviewer's `judgeFit`, given the spec's named parent. (The reviewer previously emitted
    only `possible-violation` findings — the fit verdict is the net-new output.) A
    `weak`/`none` verdict is surfaced at review so it is resolved BEFORE approval — the
    heavy LLM judgment lives at the review surface, not at commit (where it would hang
    every commit). The verdict **fails OPEN to `fit` when the reviewer is
    degraded/unreachable** — preserving "never block work by being down" and P13's "the
    work never stops."
  - **Bidirectional fork:** a non-fit is not a silent dead-end. The commit-time block
    message poses the explicit fork — *amend the constitution (propose a standard) or
    recognize the work as unconstitutional* — and per P13 the agent converts the non-fit
    into a proposed amendment and proceeds (deriving + flagging for ratification), rather
    than stopping. The review-time `weak`/`none` verdict carries the same fork in its
    reason.
  - **Authority (P2):** the fit judgment is made by the full-context conformance
    reviewer (an LLM authority reading the registry + the spec), not by a string
    match on `parent-principle` — the frontmatter field is the *claim*; the reviewer
    *judges* it.

### Phasing

- **Phase 1 (on approval):** P13 into both docs + the completion-evaluator extension
  (primary) + B18 backstop + Part C conformance-gate hardening (the traceability
  gate) + tests. The standards become real and self-applying.
- **Phase 2:** `ApprovalLedger` + `/approvals/summary` + `spec-class` frontmatter +
  tests. Read-only data; no behavior change.
- **Phase 3:** auto-approval pilot on the rollout track (dark) + the divergence
  digest + Close-the-Loop review commitments. Per-class activation operator-gated
  after eligibility holds.

Each phase is independently shippable and useful; later phases do not block earlier
value (P10 — these are sequenced deliverables, not recurrence-risking deferrals).

## Testing (Testing Integrity Standard — all three tiers)

- **Unit:** the completion-evaluator's judgment/engineering-stop classifier (both
  sides: a stop *with* a derived-standard/artifact is permitted; a bare
  judgment/engineering stop is re-injected); B18 classifier (legitimate
  completion-with-artifact passes; bare halt held); B18 added to `VALID_RULES`
  (classifier-drift / fail-open coverage — an unknown rule name must fail-open, not
  trap); `ApprovalLedger` append/verify/tamper-reject against `canonicalApprovalRow`;
  ratio + eligibility math (threshold edges, streak reset on change/reject);
  conformance fit-verdict mapping (`fit`/`weak`/`none` → pass/block/block).
- **Integration:** `POST /approvals` records a row + `GET /approvals/summary`
  computes the ratio over HTTP; the conformance gate blocks a spec whose
  `parent-principle` resolves to nothing; auto-approval route refuses a
  `governance-safety`/safety-class spec even at ratio 1.0.
- **E2E (feature-alive):** the approval + conformance routes return 200 (not 503) on
  the production init path; B18 is wired into the live `MessagingToneGate`; the
  completion evaluator's P13 branch is reachable from the real stop-hook path.
- **Wiring integrity:** B18 is registered in the gate's rule list (not a dangling
  export); the completion-evaluator extension is invoked by the real
  `/autonomous/evaluate-completion` path; `ApprovalLedger` dependency is non-null and
  delegates to the real signed store; the conformance gate is actually called by the
  pre-commit script (not a no-op import).

## Migration Parity (P3)

- P13 + Part C registry/principles text reach existing agents via the normal dist
  update (pure-doc; the conformance gate + completion evaluator are shipped code,
  reaching existing agents on update).
- The new `ToneReviewContext.autonomousActive` field is additive (default false);
  existing tone-gate callers are unaffected.
- `approvals.*` config defaults added via `migrateConfig()` with existence checks
  (off by default; auto-approval per-class false).
- The autonomous-stop-hook change (if the hook script itself changes) follows the
  built-in-hook always-overwrite migration rule.
- Agent Awareness (P5): add `/approvals/summary`, the auto-approval semantics, and
  the Constitutional-Traceability gate to the CLAUDE.md template
  (`generateClaudeMd()`).

## Side-Effects Review (canonical L6 — seven dimensions)

1. **Over-block risk.** The completion evaluator could trap a *legitimately
   finished* run; B18 could hold a genuine completion message. Mitigation: both
   favor false-negatives (permit when uncertain); the evaluator only re-injects when
   the stop *classifies* as judgment/engineering AND no artifact/derived-standard/
   operator-residual is present.
2. **Under-block risk.** A silent stop that emits no message evades B18 — which is
   exactly why the *primary* surface is the completion evaluator (R1), not the
   message gate. The conformance gate could pass a hand-wave parent — mitigated by
   judging fit with a full-context reviewer (C2), not a string match.
3. **Level-of-abstraction fit.** Enforcement is placed at the *stop decision* (the
   structural event) and the *commit* (the ship boundary), not buried in prompt
   prose — the strongest available structural surfaces (P1).
4. **Signal vs Authority (P2).** Arithmetic ratio and `parent-principle` string are
   *signals*; the LLM conformance/coherence authority *acts*. No deterministic check
   acquires acting authority (R4).
5. **External surfaces.** Adds routes (`/approvals/*`), an Attention-queue decision
   item (constitution-review fork), and a config namespace; no new outbound external
   calls; ledger is local.
6. **Interactions with existing primitives.** B15_CONTEXT_DEATH_STOP (stop-for-
   context) vs B18 (stop-for-judgment/engineering): de-conflicted by citation
   precedence `B15 > B16 > B17 > B18`. The completion evaluator extends — does not
   replace — the existing `/autonomous/evaluate-completion`. The conformance gate
   composes with the existing trace/approved/eli16 ship-gate checks. ApprovalLedger
   mirrors SessionPoolE2EResultStore. StageAdvancer reused, not forked.
7. **Rollback cost.** All additive + default-off. B18 disable = remove from
   `VALID_RULES` (fail-open). Auto-approval = per-class config flip to false.
   Conformance-gate block can be bypassed only via the audited
   `INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS`-style override (logged), preserving the gate's
   integrity. The completion-evaluator extension is behind the same autonomous-mode
   path that already exists.

## Open questions for ratification (proposals I proceed under unless redirected)

Per P13, surfaced as defaults, not blocking asks. These are **Phase-2-ledger /
Phase-3-pilot defaults only**; Phase-3 per-class auto-approval activation is
operator-gated regardless (B4).

1. **Auto-approval thresholds** — `ratio ≥ 0.85` AND `streak ≥ 10` consecutive
   approved-as-is, per class, AND the full-context authority concurs.
2. **Initial pilot classes** — start with `docs-standard` and `observability` only
   (lowest blast radius); everything else stays manual until its own data qualifies.
3. **Permanent non-auto classes** — `governance-safety` (this spec's class),
   `safety-or-credential`, `external-operation`, `multi-machine-lease`,
   `destructive-tooling`.

If any is wrong, that is exactly the divergence the ledger captures — the first
recorded `missing-principle` / `risk-reduction` data point.
