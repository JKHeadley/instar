# Side-Effects Review — Every Warning Has a Path (1.x counterpart of Rule 122)

**Version / slug:** `every-warning-has-a-path`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `GPT-6 Astra, on the final diff`

## Summary of the change

A constitution text change. A new article, *Every Warning Has a Path*, joins the Interaction family as a tree node under *Operator-Surface Quality*, which gains the back-link. It carries Justin's approved wording, the same as 2.0 Rule 122. The checks it names landed in PR 2818 and the iPhone app.

## Decision-point inventory

None added. No code path changes.

---

## 1. Over-block

No block surface. The checks it names already exist and fail only a new unannotated warning, at development time.

## 2. Under-block

The checks prove a path exists, not that it helps. Warnings in other wording than the checked tones are not seen. The article says so in **Applied through**.

## 3. Level-of-abstraction fit

A child of *Operator-Surface Quality*: that parent says a surface must be good once reached, and this says what a warning on it owes the person. *Near-Silent Notifications* is the neighbour: it decides what may interrupt, this decides what a warning must offer.

## 4. Signal vs authority compliance

Compliant: the article creates no runtime authority. The named checks are test floors.

## 5. Interactions

*Agent Proposes, Operator Approves* and *The Person Decides; the Agent Does the Rest* stay in force: a path to act is not a task handed to the person, and a fix a person must do is reduced to the smallest step. Rule text is the operator's approved wording, unchanged.

## 6. External surfaces

None at runtime. The published constitution text changes.

## 6b. Operator-surface quality

n/a, no surface changes here.

## 7. Multi-machine posture

Repo-tracked text; unified.

## 8. Rollback cost

A revert of the text, the map rows, the count assertion and the re-recorded Interaction audit.

## Second-pass review

**Reviewer:** independent cross-family reader, codex-cli on gpt-6-astra

**Independent read of the artifact: concur**

Read the final diff against the operator's approved wording and 2.0 Rule 122; see `docs/specs/reports/every-warning-has-a-path-constitution-review-2026-11-05.md`.

## Counterpart

instar-2 Rule 122 carries the same approved wording and is the master, so it merges first.

## Test expectations changed

`tests/unit/standards-coverage-ratchet.test.ts`: article count up by one.
