# Side-Effects Review — An Instar Agent Always Serves a Team (1.x counterpart of Rule 123)

**Version / slug:** `always-serves-a-team`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `codex-cli on gpt-6.1-sol, on the 1.x change and the source messages`

## Summary of the change

A constitution text change, Tier 1: one new article, 2 registry hunks plus the generated hierarchy line, the alignment-map rows, the Building family audit and report, and one count assertion. No runtime code. *An Instar Agent Always Serves a Team* joins the Building family as a tree node under *An Instar Agent Is Always a Multi-Machine Entity*, which names it back. The rule text is the wording the operator approved [source: telegram 141014/141483 2026-11-10], identical to 2.0 Rule 123 except one sentence: 2.0's "Extends #31 and #113 from machines to people." is rendered in 1.x terms as "Extends *An Instar Agent Is Always a Multi-Machine Entity*, and its cross-machine posture declaration, from machines to people." It says plainly that nothing checks it yet.

## Decision-point inventory

None added. No code path changes.

---

## 1. Over-block

No block surface. The article names a posture statement and a live proof that are owed; it builds neither.

## 2. Under-block

Until the checks exist a design can still assume one person and nothing stops it. The article says so in **Applied through**, and says existing features have not been checked against it.

## 3. Level-of-abstraction fit

A child of *An Instar Agent Is Always a Multi-Machine Entity*, because it carries that article's shape, a default posture with a stated-reason exception, from machines to people, and the approved text says it extends that rule. The parent's posture declaration keeps its own scope; the back-link sentence says so.

## 4. Signal vs authority compliance

Compliant: the article creates no authority. Whether a stated team posture is honest is a judgment held by the independent review of that change (`docs/signal-vs-authority.md`). Access itself stays with the owner's signed team record, which the agent can only narrow.

## 5. Interactions

*An Instar Agent Is Always a Multi-Machine Entity* keeps its scope. The existing team access layer (owner-signed changes, the agent can only lower access) already matches the rule for conversations; this article makes that posture the default for every feature, not only conversations. Team access in 1.x also has an admin role; the article says the named roles are examples, not a closed list. *No Feature May Require a Purchased Service* is untouched: nothing here needs an outside service.

## 6. External surfaces

None at runtime. The published constitution text changes.

## 7. Multi-machine posture

Repo-tracked text; unified.

## 8. Rollback cost

A revert of the text, the map rows, the count assertion and the re-recorded Building audit.

## Second-pass review

**Reviewer:** independent cross-family reader, codex-cli on gpt-6.1-sol

First read: VERDICT NO, 1 must-fix and 1 note. The must-fix: the alignment map's article count still said 97; corrected to 98. The note: this summary named the Building audit and report before they were in the diff; both are recorded in this change. The read confirmed the rule line matches the approved text byte for byte apart from the one permitted sentence, every operator quote matches its source including the curly apostrophes, no enforcement is claimed, Echo's parts are marked, the placement is defensible with the parent naming the child back, and the description of the existing team access is true against `src/`. Narrow recheck of the correction: VERDICT YES, 0 must-fix; counts re-verified at 98 articles, 123 rule rows, 53 aligned / 42 differs / 3 1.x-only. Concur with the review. See `docs/specs/reports/always-serves-a-team-constitution-review-2026-11-10.md`.

Source check on this machine: message 141466 matches the received message file, and Echo's 141482 matches the message log. 141472 and 141483 are not held in this machine's history; both were then read from the lease holder's topic history (Mac Studio, 2026-11-10 21:0xZ) and match: 141472 contains "in such a way that it’s always considered for every feature being built" with the curly apostrophe, and 141483 is "Yes".

Round 2, joint read of both books (codex-cli, 2026-11-10 21:08Z): VERDICT NO, 1 must-fix for this change: the In practice line said the owner gives access "only from their own phone", a device requirement the operator did not approve. Fixed: the phone is now named as how the current feature works, not a requirement. Narrow re-read of the fix: VERDICT YES. The second must-fix of that read concerned the 2.0 review record, not this change. Round-2 audit: docs/audits/always-serves-a-team-building-family-2026-11-10-r2.json with report always-serves-a-team-constitution-review-2026-11-10-r2.md; the round-1 files are kept unchanged.

## Counterpart

instar-2 Rule 123 (branch echo/rule-123-team) with the same approved text; it is the master and merges first.

## Test expectations changed

`tests/unit/standards-coverage-ratchet.test.ts`: article count 97 to 98.
