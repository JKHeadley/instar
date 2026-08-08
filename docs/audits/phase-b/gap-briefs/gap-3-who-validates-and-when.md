# BRIEF 3 — Shipping: who validates the evidence, and when?

**Take-or-decline. Self-contained. Produces a proposal document, never a registry edit.**

## The finding, verbatim

> **GAPS — Yes.** The family requires evidence and follow-through but **does not state who validates
> them or when**. *Maturation Path* concedes that "**adequacy remains the lessons-aware reviewer's
> judgment**", while *Side-Effects Review Gate* requires an artifact **without defining approval or
> content validation**.

## The state of play, already established on the branch

Both articles now carry honest measured-vs-certified declarations (landed 2026-08-07):

- *Side-Effects Review Gate* — MEASURED: an artifact of minimum length is staged and trace-declared.
  CERTIFIED: an artifact EXISTS. **It does not certify the five dimensions were reviewed.**
- *Maturation Path* — clause (a) refuses on a missing/incomplete plan. Clauses (b), (c), (d)
  (graduation-evidence quality, ship-time registration, routing) have NO mechanical check.

**So the gap is admitted and precisely bounded. What is missing is the obligation that closes it:
someone must validate CONTENT, and the family never says who or at what moment.**

## The question to answer

**Who validates that an artifact's content is real, and at which moment in the lifecycle?**

Things a good draft will weigh:

- **"The author validates their own artifact" is the null answer** and is what happens today. Say
  plainly whether that is acceptable and under what bound, rather than leaving it implied.
- **A validating REVIEWER is a cost.** Every artifact needing a second party is a throughput tax on a
  single-agent workflow. If the answer is "a reviewer for some classes only", define the classes by
  something objective (irreversibility? user-facing? a tier?) rather than by judgment at review time.
- **An LLM reviewer that fails open is not validation** — the traceability contradiction resolved on
  this branch turned on exactly that distinction. If you propose one, say which layer blocks and
  which fails open.
- **The moment matters.** Commit time, review time, and ship time are three different gates with
  three different escape hatches.

## Deliverable

`docs/proposals/standard-proposal-evidence-validation-ownership.md`: the obligation; who validates
and when; what it MEASURES vs CERTIFIES; the throughput cost stated honestly; and — if the honest
answer is that no validator can be mandated today — say so and propose the countdown instead. **An
article that names the absence beats one that invents a validator nobody will staff.**
