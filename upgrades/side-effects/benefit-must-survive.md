# Side-Effects Review — P25 (a safeguard must leave a benefit) and P26 (documents stand on their own)

**Version / slug:** `benefit-must-survive`
**Date:** `2026-11-18`
**Author:** `echo (scaling session, topic 145097)`
**Second-pass reviewer:** `not required` (documentation and review-template text; no runtime surface)

## Summary of the change

Justin's direct request (topic 145097, 2026-11-18 17:44 PST) becomes global Instar awareness:
- **Two principles:** `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` gains P25 and P26, and the reviewer index range becomes P1-P26.
- **A review question:** `skills/spec-converge/templates/reviewer-lessons-aware.md` gains Q6 ("benefit survives the walls" and "documents stand on their own").
- **A template rule:** `skills/instar-dev/templates/eli16-overview.md` opens with the stands-on-its-own rule.

## Decision-point inventory

This adds one review question to the lessons-aware reviewer. It is a reviewer judgment within the existing convergence process: DESIGN- or PRECISION-class findings, decided by the reviewer, never a keyword gate. There is no runtime decision point.

## 1. Over-block

A design that legitimately needs many walls (a security-critical change) could draw a Q6 finding. Q6 tells the reviewer not to weaken constitutional floors, and to recommend a different target rather than fewer protections when the honest benefit is near zero because of the target.

## 2. Under-block

A reviewer can still miss a design that leaves little benefit. Q6 makes the question explicit in every round, but the answer is a judgment.

## 3. Level-of-abstraction fit

It sits at the spec-review layer, where designs are shaped, before anything is built. That is the cheapest point to catch over-restriction.

## 4. Signal vs authority compliance

- [x] No: this change has no block/allow surface.

The reviewer produces findings and the convergence process weighs them, as it does for every other question.

## 4b. Judgment-point check

There is no new static heuristic. Q6 is an explicit judgment question.

## 5. Interactions

- **Lessons-aware reviewer:** Q5 (experience fit) is complementary. Q5 asks whether the design delivers the person's outcome; Q6 asks whether its restrictions left any outcome to deliver.
- **Template refresh:** the reviewer templates are refreshed in every agent by `PostUpdateMigrator` (alwaysOverwrite list), so Q6 reaches existing agents on update.
- **Tests:** the related tests pass, 99/99: `PostUpdateMigrator-feature-maturation`, `spec-review-experience-migration`, `crossModelReviewer`, `bounded-judgment-input`.

## 6. External surfaces

None at runtime. Specs reviewed after this ships get one more reviewer question.

## 7. Multi-machine posture

Not applicable: shipped documentation and templates, identical on every machine through the package and the template refresh.

## 8. Rollback cost

Revert the text. No state, no migration.

## Conclusion

Documentation-level change carrying out an explicit operator request; clear to ship.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect fixed and no self-triggered controller — not applicable.

## Addendum (2026-11-18 18:10 PST): proposed constitution articles

Justin, 18:05 PST in topic 145097: *"This is critical and should be fundamental/required and possibly part of the constitution."* So `docs/STANDARDS-REGISTRY.md` gains two articles, both marked *proposed, pending operator ratification*, and lists them under "Proposed 2.0 amendments":
- **A Safeguard Must Leave a Benefit** (Building);
- **Documents Stand on Their Own** (Interaction).

The registry's own rules make a pending article advisory and never build-failing until ratified. Ratification is Justin's: his yes on the exact text, plus his code-owner approval on this PR. The hierarchy block was regenerated. Clean: tree-parentage, single-governing-obligation, insertion-placement, code-backreference, standards hierarchy `--check`. The PR body carries the required `Constitution counterpart:` line. An instar-2 counterpart follows only if he ratifies.

## Addendum (2026-11-18 19:20 PST): ratified, and a registry fix

Justin, 19:04 PST in topic 145097: *"Yes, to all"*, answering the request that set out both articles' exact wording. Both articles are now marked ratified and each carries a `Ratified by` line.

The first version of this change failed CI: the registry checker only accepts section labels on a fixed list, and it rejected `Balanced by the floors` and `Enforcement state — PARTIAL`. The words of those sections are unchanged; they now sit inside the `Rule` and `In practice` fields, which the checker knows. No source file changes. Side effects: none beyond the registry text; the generated registry asset now counts 102 articles.

## Addendum (2026-11-18 19:30 PST): family review

Adding an article makes its family's audit record stale, so Building and Interaction were re-read by an independent reviewer (report `docs/specs/reports/safeguard-benefit-and-standalone-docs-family-review-2026-11-18.md`, audit `docs/audits/safeguard-benefit-and-standalone-docs-families-2026-11-18.json`, ledger `docs/standards-registry-area-audits.json`). Nine findings, all resolved in the text; four of them add sentences to the wording Justin approved, and were put to him in topic 145097 before his review was recorded. The ratchet test's pinned article count moves 100 to 102. `skills/spec-converge/templates/reviewer-lessons-aware.md` gains the fourth floor (the operator channel) in one sentence. No runtime code changes; no decision point is added or changed.
