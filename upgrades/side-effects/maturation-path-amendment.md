# Side-Effects Review — Maturation Path amendment

**Version / slug:** `maturation-path-amendment`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `GPT-6 Astra, on the wording and the final diff`

## Summary of the change

A constitution text change: *Maturation Path* gains default-on as the last rung, measured thresholds, the mind deciding every move, and a recorded preference final. The "unenforced" note comes out, replaced by what the coverage test and parser check and what they do not. The parser now requires a lower rung for a preference final, and the coverage test drops its hold on preference finals. Needs the operator's sign-off; merges after `docs/specs/feature-maturation-ladder.md`'s PR.

## Decision-point inventory

- The preference final — add — a recorded decision; floor and arbiter in the spec.

---

## 1. Over-block

No block surface beyond the parser's refusal of a preference final with no lower rung, which is intended.

## 2. Under-block

A review could overuse the preference final. Each is visible on the board and carries a named decider, and the operator can narrow who decides.

## 3. Level-of-abstraction fit

The rule belongs in the single governing article; it creates no new article.

## 4. Signal vs authority compliance

Compliant: thresholds are signals, the mind decides. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

*A Dark Feature Guards Nothing* stays the owner of a critical path that depends on a dark feature; a preference final says nothing about it. The master rule book's rule 72 has no preference exit, and this does not edit it; the operator is told.

## 6. External surfaces

None at runtime. The published constitution text changes.

## 7. Multi-machine posture

Repo-tracked text; unified.

## 8. Rollback cost

A revert of the text, with the area audits it re-recorded.

## Second-pass review

**Reviewer:** independent cross-family reader, codex-cli on gpt-6-astra

First read of the Maturation Path wording: five issues, applied or put to the operator. Final diff with the new article: three findings. One applied: clauses (c) and (d) stay named as unenforced, since the coverage test proves neither. Two not applied, to keep the text matching 2.0 Rule 119, with reasons in `docs/specs/reports/maturation-path-and-alignment-constitution-review-2026-11-04.md`. Concur with the review after those changes.

## One Constitution article

This PR also adds *One Constitution, Two Books Aligned*, whose check merged in #2689. `scripts/safe-merge.mjs` gains only a comment naming the article, which the back-reference lint requires. Its counterpart in instar-2 is PR 189, and the master merges first.

## Evidence

GPT-6 Astra read the diff and raised five issues (preference closure could bypass maturation, classification standing in for preference, unclear decider, overclaimed enforcement, scope of "switched-off"), all applied or put to the operator as a decision.
