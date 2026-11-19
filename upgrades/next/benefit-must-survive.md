# Two design rules: a safeguard must leave a benefit; documents stand on their own

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The design-review process gains two principles at the operator's request (2026-11-18, topic 145097):
- **P25, A Safeguard Must Leave a Benefit.** Every restriction names its cost, and something useful must survive all of them.
- **P26, Documents Stand on Their Own.** Design documents are written for a reader with no context.

The spec-converge lessons-aware reviewer asks both on every spec (Q6), and the ELI16 overview template opens with the stands-on-its-own rule. No runtime change.

## What to Tell Your User

Nothing changes in how your agent behaves day to day. Designs for new Instar features are now checked for two more things: that their safety limits still leave a real benefit, and that their documents can be read by someone with no background.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Design review asks whether a real benefit survives the safeguards, and whether the document stands on its own | Automatic in every spec review |

## Evidence

The principles text is in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (P25, P26), and the reviewer question is Q6 in `skills/spec-converge/templates/reviewer-lessons-aware.md`. Related tests pass, 99/99.
