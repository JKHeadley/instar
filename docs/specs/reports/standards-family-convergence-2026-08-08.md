# Standards family audit — convergence review, 2026-08-08

**Scope.** The Shipping, The Substrate, and Building families of `docs/STANDARDS-REGISTRY.md`.
**Reviewer.** `codex-cli:gpt-5.6` (external, dispatched with the answer withheld), ten passes.
**Criterion.** The convergence criterion ratified by Justin on 2026-08-08 (below), not "zero findings".
**Outcome.** Shipping ACCEPTED · The Substrate ACCEPTED · **Building NOT ACCEPTED** (open).

This record exists because a bare pass is not a permitted artifact under the ruling that produced it:
*"make the judgment explicit in the audit record when a review closes under it, so the record shows the
trajectory and the reasoning, never a bare pass."*

---

## 1. The criterion, and why the previous nine passes could not close

For six passes the reviewer was asked whether the family had **any** findings. It always did — a
275KB governance document reviewed on five dimensions always will. Measured that way the gate was
unreachable, and reaching it would have been evidence of a bad review rather than a good document.

Justin's ruling replaced that bar. Convergence follows an intelligent 80/20 definition: each audit
senses the **quality and magnitude** of findings per iteration and applies the highest available
intelligence to judge whether they are genuinely decreasing on whatever metric it deems worthy. We
will almost always be leaving something on the table — which is exactly why higher-level iterative
audits remain a **regular practice** rather than a one-time gate.

Operationally, acceptance requires all three of:
- **(a)** finding magnitude and severity genuinely declining across passes;
- **(b)** the remainder converted into named, **expiry-dated** work items inside the text itself;
- **(c)** nothing remaining of a kind that makes the family unusable as governance *now* — two
  articles contradicting, or a reader unable to tell which article governs.

**A named, dated gap is not a defect under this criterion. It is the intended end state.**

## 2. How the criterion was applied — and what was deliberately NOT done

The standing verdict at the time of the ruling was NOT ACCEPTED on all three families. **That verdict
was not reinterpreted.** Reinterpreting it would have made the reviewed party also the judge of
whether the review counts. Instead the criterion was placed into the reviewer's own protocol, together
with cross-pass data a single reading cannot supply, flagged as untrusted, with an explicit
instruction to refuse if the text does not support it.

It refused twice more before accepting anything, and both refusals were substantive:

1. **Criterion (b) failure** — gaps admitted in prose and never dated. Closed by dating them; the
   registry went from 15 to 23 dated sub-obligations.
2. **Criterion (a) failure** — *"the evidence supplied does not establish a declining magnitude and
   severity of findings."* This was correct and the error was the author's: the evidence offered was a
   **count** of clean answers, and a count is not severity.

## 3. The severity measure, and its honest limits

Rebuilt using the review's own notion of severity: a COHERENCE contradiction or a REDUNDANCY
duplicate-owner finding is what makes a family unusable as governance; placement and dated gaps do
not. Three families × those two questions = 6 slots per pass.

| pass | usability-blocking findings (of 6) |
|-----:|-----------------------------------|
| 1 | 6 — duplicate ownership in **all three** families, contradictions in all three |
| 2 | 4 |
| 3 | 5 |
| 4 | 4 |
| 5 | 1 |
| 6 | several (protocol changed here; reviewer became **stricter**) |
| 7 | 2 |
| 8 | 0 |
| 9–10 | 0 |

**Limits of this measure, stated because they weaken it.** The protocol changed between passes 5 and 6,
and the reviewer became *stricter* on coherence and redundancy immediately afterwards, so counts either
side of that boundary are not strictly comparable. Within the current protocol the measure is a
several-to-zero move across one repair round, then held. That is three points, not many.

**Two measurement errors were made and caught before publication.** An automated classifier read a bare
`COHERENCE — No.` as a finding in one pass and as clean in another — the reviewer uses identical wording
for opposite verdicts — producing a severity series that showed findings *increasing*, purely as an
artifact of format. A second classifier missed a lowercase heading and scored clean answers as findings.
Both were caught by reading the answers rather than trusting the parse. A precise-looking number derived
from fuzzy parsing is worse than no number.

## 4. The verdicts, in the reviewer's words

**Shipping — ACCEPTED.**
> "The severity stream is non-monotonic (6, 4, 5, 4, 1, 0) but materially declines from
> governance-breaking contradictions and duplicate ownership to none in the present family … the
> evidence under the current protocol is only a several-to-zero comparison across one repair round, so
> confidence is limited, but the remainder is explicitly named and expiry-dated and does not presently
> prevent determining which article governs."

**The Substrate — ACCEPTED.** This is the stronger of the two, because it declined to take the supplied
evidence at face value and grounded itself in the document instead:
> "The supplied numerical cross-pass series is not independently verifiable from this family, so I do
> not treat its counts as evidence. The text itself does document earlier governance-breaking
> conflicts — 'two articles each claiming to own it' and an obligation 'stated in three places with no
> boundary' — and their present consolidation; the current remainder is placement or enforcement work
> named and expiry-dated, supporting a genuine decline in magnitude."

**Building — NOT ACCEPTED, and it stays open.**
> "A current cross-article notification contradiction remains, and multiple admitted enforcement gaps
> lack named, expiry-dated work items."

## 5. What these two acceptances do NOT certify

- **Not that the families are finished.** Both carry open, dated work. Shipping's *Token-Audit
  Completeness* is agreed to be misplaced; The Substrate has four articles that fail its own newly
  written admission rule. Both are recorded with dates.
- **Not that the placement question is settled.** Re-filing those articles trips an unrelated
  enforcement-density ratchet (measured, not argued: moving one yields
  `ratio 19/29 < floor 20/30` while the registry-wide enforced ratio is invariant at 0.7356). That
  decision is the operator's and is **held** pending it. The decision itself now carries a date.
- **Not that the reviewer is right.** It is one external model applying a stated criterion to a text.
  Its acceptance of Shipping came with its own confidence caveat, which is the main reason to trust it.

## 6. Standing practice

Per the ruling, this is not a gate that has now been passed. Higher-level iterative audits remain a
**regular practice**, precisely because something is always left on the table. Building is open; the
23 dated sub-obligations across the registry come due 2026-09-07 and are enforced by
`scripts/lint-documented-only-countdown.mjs`, which fails the build on an expired date.
