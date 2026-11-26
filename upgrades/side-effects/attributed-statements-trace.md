# Side-Effects Review — Attributed Statements Trace to Their Source (1.x counterpart of Rule 121)

**Version / slug:** `attributed-statements-trace`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `GPT-6 Astra, on the diff of both books`

## Summary of the change

A constitution text change, Tier 1: one new article, 2 registry hunks plus the generated hierarchy line, the alignment-map rows, the Interaction family audit and report, and one count assertion. No runtime code. *Attributed Statements Trace to Their Source* joins the Interaction family as a tree node under *Truthful Provenance — Speak Only as Yourself*, which names it back. The rule text is the wording the operator approved [source: telegram 136110/139199 2026-11-05], identical to 2.0 Rule 121. It says plainly that nothing enforces it yet. Proportion: five independent review rounds, the last three narrow rechecks of its own review records; more than a Tier-1 change usually takes, because each round also read the records describing the earlier rounds and found a sentence to correct.

## Decision-point inventory

None added. No code path changes.

---

## 1. Over-block

No block surface. The article names checks being built under a separate spec; it builds none.

## 2. Under-block

Until the checks exist an agent can still credit a person with no source and nothing stops it. The article says so in **Applied through**. The 73 notes corrected by hand on 2026-11-05 are not enforcement.

## 3. Level-of-abstraction fit

A child of *Truthful Provenance*, because the gap is the one that article leaves: it protects who a delivered message is from, and stops there. *Session Input Is a Principal* is the grandparent through the merged-subsection relation. *What a provenance field claims* governs labels inside this registry and is a different subject.

## 4. Signal vs authority compliance

Compliant: the article creates no authority. The checks it names are designed under `docs/signal-vs-authority.md` in their own spec. Whether words support a claim is a judgment, not a string match.

## 5. Interactions

*Truthful Provenance* keeps its scope; the back-link sentence says so. *Telegram Message Origin Is Mandatory; Its Display Is Optional* is a sibling with a different subject (who produced an outgoing message) and is byte-identical. The Cross-Agent Communication Discipline in the CLAUDE.md template forbids writing in another identity's voice in shared files; this reaches the operator and an agent's own memory. "Cite Without Source" and the "Inherited Claims" trap remain prose in the template and now have an article behind them.

## 6. External surfaces

None at runtime. The published constitution text changes.

## 7. Multi-machine posture

Repo-tracked text; unified. The rule itself names every machine, and the enforcing spec holds its own posture.

## 8. Rollback cost

A revert of the text, the map rows, the count assertion and the re-recorded Interaction audit.

## This pull request carries two rules

*No Feature May Require a Purchased Service* (1.x counterpart of 2.0 Rule 122) is in the same pull request, so one review covers both articles. Its own review is `upgrades/side-effects/no-purchased-service.md`. Together they add articles 96 and 97, the map rows, the Interaction and Building family audits with their reports, and the count assertion. Still no runtime code, and neither article is enforced yet.

## Second-pass review

**Reviewer:** independent cross-family reader, codex-cli on gpt-6-astra, through the charter launcher

Round 1 read both books' diffs, the source messages, the case study and the note check: VERDICT NO, two must-fixes, both in the 2.0 text (a report over stored statements had become a duty the approved wording does not state; the source note named a requirement without its words). Both repaired. Rule bodies byte-identical to the approved draft in both books; incident facts and counts match their records; no enforcement overclaim; placement sound; the `Fails` direction fits the failure-direction defaults. Round 2 rechecked the repairs and the 2.0 anchor: VERDICT YES, 0 must-fix. Round 3, on the final records, found one false sentence in the review report (it said the ELI16 keeps the one-reader limit), now corrected. Round 4 confirmed that correction and asked that the report's pointer to the pull request be made true, which the pull request body now does. Round 5 records the last read of this article alone on the pull request. A read of the combined diff of both articles returned NO on one must-fix in the supporting records (current-change statements still saying 95 to 96, and a note still calling R121's pair open), corrected here; the rule bodies, quotes, counts and enforcement statements passed. The result of the narrow recheck is on the pull request.

## Counterpart

instar-2 Rule 121 with identical rule text; it is the master and merges first.

## Test expectations changed

`tests/unit/standards-coverage-ratchet.test.ts`: article count 95 to 97, with the second article.
