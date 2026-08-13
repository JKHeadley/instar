# Standards area audit — 2026-08-13 (Window-14 decision-package application)

**Why this audit exists.** The live rulebook was amended in ~95 places to apply six of the operator's
seven Window-12 rulings. Every amended area's audit record went stale, and the coverage ratchet
refuses a stale area — correctly, because that is the registry's own rule: **amend an area, re-audit
it.** This is that audit.

**Scope.** All six areas (`The Root`, `The Fractal`, `The Substrate`, `Building`, `Shipping`,
`Interaction`). The amendment touched every one.

**Reviewers.** `codex-cli:gpt-5.6-sol`, dispatched with the answer withheld, each lens given only the
material for its own question and explicitly forbidden from exploring the tree. Three independent
lenses plus three analysis lanes, listed below with what each found.

---

## What the change was

Six rulings applied; one deliberately not applied and escalated.

| ruling | applied | shape of the change |
|---|---|---|
| 1a emergency stop vs blocking authority | yes | 2 articles: a named narrow exception + its reciprocal |
| 1b precedence residual | yes | 1 new section; escalate-and-log on the true residual |
| 2 the 57 silent failure directions | yes | 53 `**Fails.**` lines (+1 via 1a) and 1 new section recording the 7 group defaults |
| 3 paperwork gates to behaviour checks | yes | 1 new section (9 mechanisms) + 8 `**Judgment-bound.**` labels |
| 4a retire the 29 superseded | **no — escalated** | nothing applied |
| 4b the 14 unstated origins | yes | 14 provenance lines |
| 4c the 9 rhetorical "recurring" claims | yes | merged into the 14 above |

Article count unchanged at **87**. Enforcement coverage unchanged at **0.7356**, which is the check
rather than a coincidence: an amendment that moved it would mean narrative text had leaked into
enforcement extraction. Dangling refs **0**. Unrecognized sections **0**.

---

## Lens 1 — blind behaviour

Given ten scenarios **without** the intended answers, and told to reason only from the amended text,
quoting the sentence it relied on for each answer.

**Result: 6 CLEAR / 3 AMBIGUOUS / 1 NOT COVERED.** Two genuine defects, both in material this change
introduced:

1. **The four new provenance labels had no stated meaning.** Asked whether an article labelled
   `Provenance status. Provenance lost:` is still binding, the lens answered that the text *"does not
   expressly say"* — and on `Grounded in.` it answered **NOT COVERED**. Correct, and this change's
   fault: four labels were introduced and never defined. **Fixed** — a new section now defines all
   five provenance fields and states plainly that a provenance field records where a rule came from,
   never how much it binds.
2. **Whether the operator's own named stop phrase is in the enumerated list is not checkable from the
   constitution.** The article deliberately makes the *code constants* authoritative and calls the
   inline examples illustrative. **Not fixed, deliberately** — that design was ratified 2026-08-07/08,
   the article already carries an `UNENFORCED SUB-OBLIGATION` saying nothing validates whether an
   enumerated entry is semantically safe, and changing where that authority lives would be a new
   ruling rather than an application of an existing one.

The remaining six answers matched the intended behaviour, including the one that matters most for
ruling 3: asked whether a lint over a declaration could mark a `Judgment-bound` article "enforced",
the lens answered **no**, quoting the article's own text back.

## Lens 2 — fidelity to the operator's recorded rulings

Given the operator's words as the authority and the applied text, and required to quote the sentence
any finding allegedly violates. Returned **REJECTED with three findings**. Disposition:

1. **"Ruling 1b's logging condition was not operationally applied" — REFUTED.** The lens was given a
   truncated excerpt that omitted the residual section entirely; its own coverage note flagged the
   gap. Re-run with the full section, the same lens returned **BOTH-PRESENT** and **HONEST-COMPLIANCE**,
   quoting the binding sentences back. The finding was an artifact of how the review was assembled,
   not a defect in the change — recorded here rather than quietly dropped, because a review whose
   input was wrong is a fact about this audit.
2. **"Agent Awareness was moved off the operator-approved 5/4/5 split" — UPHELD, and the fix is
   better than either original position.** The operator approved four articles as *keep-and-re-earn*;
   applying the ruling surfaced the missing evidence, and the change reclassified the article. The
   lens argued that "until re-earned" authorises the future transition but does not erase which four
   articles he approved into that category. It also named the better route: **record the re-earning
   as an event**. Applied — the article now states it was ruled keep-and-re-earn and re-earned on
   2026-08-13, with the evidence, so the approved disposition and the honest label both survive.
3. **"The DERIVED failure direction overreaches" — UPHELD.** Ruling 1a establishes that a cheap
   matcher gains no veto when the intelligent gate is absent. It does **not** by itself establish
   that the action proceeds — a system could deny the matcher authority and still hold because its
   authoritative decider is unavailable. The single-source derivation claimed more than the ruling
   supports. **Fixed** — the direction now rests on two attributed sources: 1a for *who may block*,
   and the already-ratified *The User Experience Is the Product* ("when a guard cannot do its job, it
   must fail toward the user being served") for *whether the action proceeds*.

**Verified as matching the ruling with no finding:** the seven group defaults, group by group,
including the five-closed / two-open asymmetry; the three fallback follow-ups recorded as
deliberately not built, including that "have a fallback" stays RECOMMENDED and unratified; ruling 3's
nine mechanisms and both halves of the judgment-quality obligation.

## Lens 3 — cross-article contradiction

Given the amended articles and the three new sections, with a **mandatory resolution gate**: before
reporting a contradiction, test whether an existing mechanism already resolves it. (A prior review of
this same document alleged six contradictions and four were refuted by exactly this test — two of
those four had already been reported upward as real.)

**Result: 0 findings, 4 candidates discarded by the gate.** The discard list is the valuable half:

- *The Body and the Mind* forbids structure commanding, while the exact-match floor halts alone —
  discarded: the latter declares itself the sole bounded exception.
- *Signal vs. Authority* reserves blocking authority to an intelligent gate, while the floor vetoes —
  discarded: **both articles now name the exception**, which is precisely what ruling 1a added.
- *Signal vs. Authority* fails open while the emergency floor still halts — discarded: its `Fails`
  clause preserves that carve-out explicitly.
- The fail-closed defaults versus Signal's fail-open — discarded: each article's own `Fails` line
  governs its own machinery, and any genuine residual is resolved by the new residual clause.

Three of those four discards were resolved **by material this change added**, which is the useful
reading: the amendment closed the collisions a reviewer would otherwise have raised.

## Analysis lanes (content production, each with its own verification step)

- **Absorption classification (ruling 4a).** All 29 superseded articles classified against the live
  rulebook: 25 absorbable with a named live target, 3 root, 1 orphan; 5 of its own candidates
  discarded by the mandatory "does an existing mechanism already resolve this?" step. Verified
  independently: every named target resolves to a live article, and **none is itself retiring**.
- **Failure directions (ruling 2).** 55 articles, 53 NEW / 2 ALREADY-STATED / 0 CONFLICT / 0
  MACHINERY-UNCLEAR. The two already-stated were left alone — the ruling fills silence, it does not
  re-decide settled cases.
- **Provenance (rulings 4b/4c).** 14 articles, one disposition changed after checking the live text
  (see lens 2, finding 2).

---

## Findings disposition

| # | source | finding | disposition |
|---|---|---|---|
| 1 | blind | provenance labels undefined; binding force unstated | **fixed** — new section defines all five and states force is unaffected |
| 2 | blind | enumerated-list membership not checkable from the constitution | **accepted, not fixed** — pre-existing ratified design, already carries a named sub-obligation |
| 3 | fidelity | 1b logging not applied | **refuted** — artifact of a truncated review input; re-run returned both-present |
| 4 | fidelity | Agent Awareness moved off the approved split | **fixed** — recorded as an explicit re-earning event |
| 5 | fidelity | derived fail-direction overreaches 1a | **fixed** — split across two attributed sources |
| 6 | contradiction | none | — |

**No unresolved design findings.** Two items are carried deliberately and are named in the registry
itself rather than here: the residual-collision write and the judgment-call write are both
`UNENFORCED SUB-OBLIGATION` with dated countdowns (`2026-09-13`). Ruling 4a is escalated and
unapplied.

## Coverage limitations, stated

- The fidelity and contradiction lenses judged the **new and amended** text, not all 87 articles.
  Two of the three had to be re-run after their first attempt exhausted its budget exploring the
  tree; the surviving runs were given inline material and each states its own coverage.
- Verification of the 53 individual `**Fails.**` sentences against each article's real machinery was
  done by the producing lane with a mandatory check against the live text, not re-verified
  article-by-article by a second lens.
- Behaviour is proven only where mechanically constructible. The provenance labels and the
  judgment-bound acceptances are **inspection-verified** against the operator's recorded rulings and
  are reported as such — never as behaviour-proven.

## Verdict

**Accepted for all six areas.** Five findings raised, one refuted on re-examination, three fixed, one
accepted with its reason stated. Zero unresolved design findings, zero contradictions surviving the
resolution gate, and the two enforcement gaps that remain are named in the registry with dates rather
than implied away.
