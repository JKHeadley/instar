# Side-Effects Review — trust-journey constitution amendments 1-8 (1.x book)

**Version / slug:** `trust-journey-amendments`
**Date:** `2026-11-15`
**Author:** `echo`
**Second-pass reviewer:** `codex-cli on gpt-6-astra (verbatim fidelity and cross-references)`

## Summary of the change

A constitution text change, Tier 1. The operator approved version 1 of the constitution amendments document exactly as written [source: telegram 142440/4516843644856181 2026-11-16T06:01:41Z]. This lands the 1.x text verbatim: *Sovereignty* rewritten to the grant-based test with a ROOT placement line (change 7); two additions to *Intelligence Infers, Keywords Only Guard* (change 8a); a new Interaction article *Trust Is Earned by Work and Granted Only by the Person* carrying changes 2, 4, 5, 6 and 8b, a tree node under *Agent Proposes, Operator Approves*, which names it back. Placeholders filled: ratification date 2026-11-15 and the approval citation. The alignment map, placement baseline (Sovereignty now declares a placement, so it leaves the grandfathered list), generated hierarchy block, the Interaction and Substrate family audits and the article-count assertion (98 -> 99) follow.

One script changes: `scripts/lint-registry-tree-parentage.mjs` read only the first child after "Tree node(s) beneath it:", so the approved plural acknowledgement ("Tree nodes beneath it: *A*; *B*.") failed the lint. It now reads every italic name in a list joined by ";", "," or "and". A new unit test fails on the old script and passes on the new one, and proves an unacknowledged child and an unrelated later italic name are still refused.

An internal-only release-note fragment (`upgrades/next/trust-journey-amendments.md`) carries the lint change to release; it has no user-facing surface. The alignment map names the paired 2.0 pull request, JKHeadley/instar-2#204.

Size: 4 governed files, 1 script, 2 tests, audits and artifacts. Effort: one fidelity review round; commit attempts recorded in the PR.

## Decision-point inventory

The parentage lint is a commit-time structural check over the registry, not a runtime decision point. Its change widens what it parses as an acknowledgement to a list form; it does not loosen the bidirectionality requirement.

---

## 1. Over-block

The old lint over-blocked the plural form; this fixes it. No new rejection is added.

## 2. Under-block

A list item now counts as an acknowledgement only inside the contiguous italic list that follows "beneath it:". A child named elsewhere in prose is still not an acknowledgement (tested). The new article is unenforced and says so in **Applied through**.

## 3. Level-of-abstraction fit

The fix lives in the lint that owns "a declared relation must be real and bidirectional", not in a new check.

## 4. Signal vs authority compliance

Compliant. The articles create no runtime authority; the lint keeps its existing commit-time role (`docs/signal-vs-authority.md`). Whether an offer is the same task stays a model judgment, which is what change 8a says.

## 5. Interactions

`generate-standards-hierarchy.mjs` consumes the lint's relations and now renders both children of *Agent Proposes, Operator Approves*. *The Person Decides; the Agent Does the Rest*'s sentence citing *Sovereignty* becomes accurate. *Self-Unblock Before Escalating*'s rung floor may still keep a 1.x agent asking for irreversible acts inside the role; recorded as an unsure note in map row 23, as the approved document directs; a wording fix is a separate operator decision.

## 6. External surfaces

None at runtime. The published constitution text changes.

## 7. Multi-machine posture

Repo-tracked text; unified across machines through the release.

## 8. Rollback cost

A revert of the text, map rows, baseline line, lint and test, the audits and the count assertion.

## Second-pass review

**Reviewer:** independent reviewers in fresh context, not the author: the constitution review of the amendments (`docs/specs/reports/trust-journey-amendments-constitution-review-2026-11-15.md`) and, after main was merged in, a fresh reader of the merged Interaction family (`docs/specs/reports/interaction-family-merge-review-2026-11-16.md`)
**Independent read of the artifact: concur**

The first review covers the three amended articles and their audits. The second covers the family as merged with *Security Fixes Keep the Experience Whole* (PR 3200): no contradiction and no duplicated obligation, no approved wording changed by the merge, and the family audit `docs/audits/interaction-family-merge-2026-11-16.json` recorded after that read.

## Counterpart

Constitution counterpart is the paired instar-2 pull request named in the PR body.
