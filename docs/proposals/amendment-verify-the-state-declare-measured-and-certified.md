# PROPOSED AMENDMENT — not yet ratified

**Status:** AMENDMENT to an existing standard. Agent proposes, operator ratifies. Deliberately NOT
written into `docs/STANDARDS-REGISTRY.md`.
**Amends:** **Verify the State, Not Its Symbol** (the Substrate).
**Replaces:** the standalone proposal *A Check's Passing Condition Must Cover What It Certifies*
(`standard-proposal-passing-condition-must-match-the-claim.md`), which is **withdrawn as a new standard**.
**Proposed by:** Echo — Pathway, 2026-08-05.

---

## Why this is an amendment and not a standard

The placement sweep read all 82 registry standards against the original proposal. Its substance is
already owned, in two places:

- **Verify the State, Not Its Symbol** already forbids accepting *"the mere presence/absence of a proxy
  signal as proof the state holds."* Five of the proposal's seven instances are exactly that: a
  12-character reason certified as "justified," a resolving ref certified as "enforced," a counter at a
  path certified as "instrumented." The crystallizing case — an assertion that a returned value *is a
  list*, standing in for *"contains no dangerous operations"* — is the same shape.
- **Testing Integrity** already requires *"semantic-correctness tests for both sides of every decision
  boundary,"* which is the two-sided obligation the proposal argued for.

**What neither standard contains is a declaration duty.** Both tell an author what a check may not
conclude. Neither requires the author to *write down*, at authoring time, the two things whose
divergence is the defect. That gap is one clause wide — and a one-clause gap in an existing standard is
an amendment, not a sibling.

The original proposal's own enforcement section said so before I did: the `/spec-converge` gate
*"already fires on this class... under Verify the State, Not Its Symbol"* and *"the change is scope, not
machinery."*

---

## The amendment

**To the Rule**, appended:

> This obligation binds a check's account of **itself**, not only its account of the world. Every check —
> a lint, a gate, a ratchet, a test assertion, a classifier, a status field, a reported ratio — must state
> **(a) the condition it evaluates** and **(b) the claim its result will be read as certifying**, and
> those two must be argued equal. A passing condition narrower than its certified claim is a symbol
> standing in for a state one level up: it converts *"I could not detect a problem"* into *"there is no
> problem,"* and does so most confidently in exactly the cases it cannot see.

**To In practice**, as a fourth tooth beside (A) corroborate, (B) isolate, (C) name the fail-direction:

> **(D) Answer the passing-condition question before the check ships** — *"what input passes this check
> while failing the claim?"* If an answer exists and is not argued out of scope, the check is mis-scoped
> and must be **narrowed in claim or widened in condition**. Where only a proxy is measurable, the result
> must be **named as the proxy** (`ref-resolves`, `not-registered`, `no-counted-invocation`) and never as
> the claim (`enforced`, `missing`, `bypassed`) — because the name is what a reader acts on. This is the
> two-sided obligation *Testing Integrity* already places on tests, extended to every check; a check that
> cannot fail is not evidence, and a check paired with a control that must fail is.

---

## Scope of the amendment, stated honestly

**This adds an authoring discipline, not machinery.** Ratifying it does not make it enforced — which is
itself an instance of the class it describes, and the reason the sentence is here rather than implied.

**Landable surfaces, in the order they can actually land:**

1. **`/spec-converge`'s lessons-aware reviewer already fires on this class** under the parent standard —
   it raised it five times against this window's own spec. The change is scope: ask the
   passing-condition question about the **check a spec introduces**, not only about the detector's
   subject. Smallest real step, available now.
2. **A B-case obligation on new checks.** `standards-coverage-ratchet` already carries eleven explicit
   negative controls; the pattern is proven by injection.
3. **Two named repairs that are the test of whether this bites:** `COHERENCE_MANIFEST_EXCLUSIONS`'s raw
   `.length > 20` check, and `/guards` `missing` lacking lease-awareness. **If this is ratified and those
   two do not change, it is prose.**

## What I am NOT claiming

- **Not that the parent standard was wrong.** It is correct and it is load-bearing. It was scoped to the
  detector's subject, and this widens it by one clause.
- **Not that seven instances proves universality.** Seven found in one window by one agent looking for
  one thing. A reviewer may reasonably argue the class is narrower than stated.
- **Not that the two-sided rule is new.** *Testing Integrity* has it for tests. The amendment generalises
  it and cross-references rather than restating it, so the registry does not end up with two owners of
  one obligation — which is the defect the sibling proposal *Remove What Demands Attention* names.

## The question this raised and I did not chase

The sweep found **29 of 82 standards** touching this class. That is either a sign the class is genuinely
foundational, or a sign the overlap test is too loose to discriminate. **I did not investigate which**,
because doing so would have been a new sweep. Naming it: *does a 29-of-82 overlap count as evidence of
importance, or evidence that the comparison method over-matches?* It bears on every future placement
decision, and it is unanswered.
