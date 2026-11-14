# Side-Effects Review — No Feature May Require a Purchased Service (1.x counterpart of Rule 122)

**Version / slug:** `no-purchased-service`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `GPT-6 Astra, on the changes in both books`

## Summary of the change

A constitution text change, Tier 1: one new article, 2 registry hunks plus the generated hierarchy line, the alignment-map rows, the Building family audit and report, and one count assertion. No runtime code. *No Feature May Require a Purchased Service* joins the Building family as a tree node under *Framework-Agnostic — and Framework-Optimizing*, which names it back. The rule text is the wording the operator approved [source: telegram 136110/139311 2026-11-05], identical to 2.0 Rule 122. It says plainly that nothing enforces it yet. Proportion: one completed read of this article alone, then the read of the combined diff. It shares a pull request with *Attributed Statements Trace to Their Source*, and this summary covers this article only.

## Decision-point inventory

None added. No code path changes.

---

## 1. Over-block

No block surface. The article names a boot test that is owed; it builds none.

## 2. Under-block

Until the test exists a design can still need a paid service and nothing stops it. The article says so in **Applied through**, and says existing features have not been checked against it.

## 3. Level-of-abstraction fit

A child of *Framework-Agnostic*, because the gap is the one that article leaves: its floor reaches engines and AI providers, and stops there. The independent read called this defensible and a root position defensible too.

## 4. Signal vs authority compliance

Compliant: the article creates no authority. Whether a design degrades core function is a judgment held by that design's review (`docs/signal-vs-authority.md`).

## 5. Interactions

*Framework-Agnostic* keeps its scope; the back-link sentence says so. *One provider is enough* still answers the question of a second AI provider; a subscription the person has not chosen gets no shelter from the last sentence. *The Person Decides; the Agent Does the Rest* still covers who sets up a free outside account. *Recommended outside services* offers optional services and fits: each is a yes or no the person can decline.

## 6. External surfaces

None at runtime. The published constitution text changes.

## 7. Multi-machine posture

Repo-tracked text; unified.

## 8. Rollback cost

A revert of the text, the map rows, the count assertion and the re-recorded Building audit.

## Second-pass review

**Reviewer:** independent cross-family reader, codex-cli on gpt-6-astra, through the charter launcher

VERDICT YES, 0 must-fix, 2 notes: the map's pending R121 bookkeeping and an unchanged real-clock refusal in 2.0, both recorded. Rule bodies byte-identical to the approved draft in both books; quotes match the log; no enforcement overclaim; the last sentence is marked as Echo's in both books; counts re-counted. A first launch was ended by a signal partway through and was rerun; only the completed run counts. Then the combined diff was read: see `upgrades/side-effects/attributed-statements-trace.md`, whose trace covers both articles.

## Counterpart

instar-2 Rule 122 with identical rule text; it is the master and merges first.

## Test expectations changed

`tests/unit/standards-coverage-ratchet.test.ts`: article count 95 to 97, with *Attributed Statements Trace to Their Source* in the same pull request.
