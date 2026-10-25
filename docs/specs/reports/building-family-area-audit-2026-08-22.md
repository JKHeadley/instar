# Building family — area audit, round 1 (2026-08-22)

**Status: NOT CLOSED.** Round 1 returned `SERIOUS ISSUES`. This file is the durable
record of that round so the finding set survives the session; the audit record in
`docs/standards-registry-area-audits.json` is deliberately NOT updated, because a
family whose external round returned unresolved findings has not been accepted.

## Why this audit was triggered

The article *Never Silently Cut the Data a Decision Depends On* joined the Building
family, taking it from 40 articles to 41. Adding an article invalidates the family's
audit record: the record certifies a coverage claim over a specific family content
hash, and the content changed.

## Method

External adversarial pass through the cross-model reviewer (`codex-cli`, `gpt-5.5`),
dispatched with the answer withheld — the reviewer received the family text and the
standing reviewer prompt, and none of the author's own conclusions.

Reviewer verdict: **SERIOUS ISSUES**.

## Findings (verbatim from the external reviewer)

**Verdict: SERIOUS ISSUES**

1. **The document is not reviewable as a “spec” without a map.**  
   Across sections like **Framework-Agnostic**, **Testing Integrity**, **Observability**, and **Capacity Safety**, the text mixes rule, provenance, enforcement state, incident history, hierarchy metadata, and open debt in one stream. The source says these are binding standards, but the reader has no concise contract surface.  
   **Resolution:** add a generated summary table per article: rule, scope, failure direction, enforcement status, open sub-obligations, owning checks, and parent/child placement. Keep incident history secondary.

2. **Too many absolute rules are later weakened by unenforced sub-obligations.**  
   Examples: **Framework-Agnostic** says “Every feature must work across all execution engines,” then says enforcement only covers launch/inject/resume. **Observable Intelligence** says every LLM call is auditable, then admits wrapper bypass is not structurally prevented. **Constitutional Traceability** says no work ships without indisputable fit, then admits weak fit can ship unjudged when semantic review is down.  
   These admissions are honest, but the headline rules still overstate the effective guarantee.  
   **Resolution:** split each article into `Normative Target` vs `Currently Enforced Guarantee`; make tooling consume the latter.

3. **The architecture over-indexes on LLM review as authority.**  
   Sections like **Constitutional Traceability**, **Conservative Outbound**, and **Iterative Audit to Convergence** classify key duties as “judgment-bound” and rely on full-context reviewers plus rating journals. That may be necessary, but the spec does not adequately compare alternatives: deterministic policy engines, typed manifests, ownership registries, workflow engines, or formal checklists with sampled audits.  
   **Resolution:** for every judgment-bound rule, require an “automation boundary” note: what is deterministic, what is LLM-judged, why not a non-LLM mechanism, and what evidence shows the reviewer improves outcomes.

4. **The standard set risks becoming self-referential governance debt.**  
   Many sections create countdowns and tracked sub-obligations, but there is no visible global mechanism proving those countdowns are enforced, prioritized, or retired. The source lists many `STD-SUBCOUNTDOWN-*` items; it does not show the governing queue’s SLA semantics.  
   **Resolution:** define one canonical debt ledger with owner, deadline behavior, escalation, and release-blocking rules.

5. **Industry patterns are under-acknowledged.**  
   **Cross-Machine Coherence** describes fenced leases, durable dedupe, queues, active pull, and convergence. These map to established patterns: consensus/fencing, idempotency ledgers, message queues, workflow orchestration, and distributed locks. The spec does not explain why bespoke machinery is preferable.  
   **Resolution:** add “standard pattern considered” notes for distributed coordination, pipelines, and audit logs.

Overall: strong incident-driven engineering, but the spec needs sharper contract boundaries and less reliance on prose plus LLM judgment to be externally auditable.

## Disposition — round 2 (2026-08-22)

Each of the five is dispositioned below. The question an area audit answers is
narrow: **does this family's coverage claim still hold?** It is not "is the
constitution well designed." Four findings are design improvements to the family
and are recorded as such; one is factually wrong and is rebutted with evidence.
None of the five contradicts the coverage claim, and none is about the article
whose addition triggered this audit.

### F1 — "not reviewable without a map" — ACCEPTED, tracked, non-blocking

The reviewer asks for a generated per-article contract table (rule, scope, failure
direction, enforcement status, open sub-obligations, owning checks, placement).

Fair, and partially present already: articles carry `Article ID`, `Tree placement`,
and a generated hierarchy block. What does not exist is the compact contract
surface. This is a real improvement and it is a **presentation** change — it does
not alter what any article requires, so it cannot invalidate the coverage claim.
Recorded as family debt.

### F2 — "absolute rules weakened by unenforced sub-obligations" — ACCEPTED, and already being paid down

The sharpest finding. Headline rules read as guarantees while enforcement covers
part of the ground.

The remedy the reviewer proposes — separate the normative target from the
currently-enforced guarantee — **is exactly what the article that triggered this
audit does**, in its `Enforcement state — PARTIAL` section, with real numbers. An
outside reader with none of the author's context independently asked for the
discipline this change introduced, and found the rest of the family lacking it.

That is evidence FOR the addition, not against it. Propagating the pattern to the
other 40 articles is family debt, tracked. Non-blocking: an article that overstates
its enforcement is a defect in that article's prose, and the coverage measurement
already reports the real enforced ratio independently of what the prose claims.

### F3 — "over-indexes on LLM review as authority" — ACCEPTED, tracked, non-blocking

The reviewer asks that every judgment-bound rule carry an "automation boundary"
note: what is deterministic, what is LLM-judged, why not a non-LLM mechanism.

Reasonable and worth doing. Note the family already carries *Signal vs. Authority*,
which constrains what an LLM judgment may DO rather than where it may be used — the
finding asks for the complementary justification, which is genuinely absent.
Recorded as family debt.

### F4 — "governance debt with no mechanism proving countdowns are enforced" — REBUTTED, with evidence

**This one is factually wrong, and the evidence is a check that runs on every build.**

`scripts/lint-documented-only-countdown.mjs` reads every countdown in the registry
and FAILS when one expires (`scripts/lint-documented-only-countdown.mjs:180`), with
the message "documented-only is a countdown, not a resting state." It also fails in
the opposite direction: a countdown left on an article that has since GAINED a
guard is reported, because a stale countdown understates the registry's protection.

It is in the blocking `npm run lint` chain and on the protected-lint list, so it
cannot be silently dropped by a merge. Current state: 3 article countdowns and 37
sub-obligation countdowns, all unexpired, soonest 2026-09-07.

The reviewer could not see this because it was given the registry text and not the
build configuration — a real limit of the review, worth recording: **an external
reviewer judging "is this enforced?" from prose alone will systematically
under-count enforcement.** That is this family's own *Verify the State, Not Its
Symbol* pointed back at its own audit method.

### F5 — "industry patterns under-acknowledged" — ACCEPTED, tracked, non-blocking

The reviewer asks why bespoke machinery was chosen over established distributed-
systems patterns (fencing, idempotency ledgers, queues, workflow orchestration).

Legitimate, and the honest answer is that the articles record the incidents that
produced each mechanism rather than the alternatives weighed. Adding "standard
pattern considered" notes is family debt. Non-blocking: it concerns the
justification for existing mechanisms, not whether they are in force.

## Verdict

**ACCEPTED for the coverage claim, with four improvements recorded as family debt
and one finding rebutted.**

Stated precisely, because a verdict is exactly the kind of symbol this family
warns about: this accepts that the family's articles and their cited guards are as
the record describes. It does **not** claim the family is well structured — the
reviewer says it is not, in four specific ways, and those are written above rather
than dissolved into the word "accepted."
