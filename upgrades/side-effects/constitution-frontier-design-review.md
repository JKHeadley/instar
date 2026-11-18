# Side-Effects Review — Frontier Models Design and Review; Efficient Models Build (1.x counterpart of 2.0 Rule 124)

**Version / slug:** `constitution-frontier-design-review`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `codex-cli on gpt-6.2-sol, on both books' diffs, the approved article and the source messages`

## Summary of the change

A constitution text change, declared Tier 2 because the article is part of the approved Tier 2 spec `docs/specs/frontier-design-review-standard.md`. No runtime code. One new article, *Frontier Models Design and Review; Efficient Models Build*, lands with the exact text of the spec's "Constitution wording" section, which the operator approved ("approved" [source: telegram 144319/144458 2026-11-17T23:32:37Z]; decision 7 makes that approval cover the article). It sits in the Building family right after *Keep the Doorway/Model Map Current* and is a tree node under *Structure beats Willpower*, which names it back in one sentence. Its added **Tree placement.** line, marked as the agent's, carries the placement and the exact message pointers. Checklist from the spec: hierarchy regenerated (47 relations across 27 parents), coverage count 100 to 101 in `tests/unit/standards-coverage-ratchet.test.ts`, Building and The Root family audits re-recorded with one report, an alignment-map pair row and change row, and the 2.0 briefing-sync check (`tests/preview/constitution-briefing-sync.test.ts` in instar-2) passing. The spec, its overview and its convergence report are copied byte for byte from the open spec PR #3323 so the trace and the article's own reference resolve; the two copies merge cleanly. Effort: three review rounds on the paired change (two in the 2.0 book, one in the alignment map and placement paragraph), proportionate for a two-book constitution change.

## Decision-point inventory

None added. No code path changes.

---

## 1. Over-block

No block surface is added by this change. The article names the outbound gate and Work Board hold; those are built by the spec's stages, not here.

## 2. Under-block

Until stages 1 and 3 merge, nothing applies the article. Its Applied-through line names `src/core/designLane.ts` and `B26_DESIGN_APPROVAL_UNREVIEWED`, which are not on main yet; the standards-coverage check counts them as 2 dangling references and fails until that code lands. This is stated, not hidden: the article's wording is the operator's and is not changed to pass the check, so this pull request merges after the stage 1 and stage 3 code.

## 3. Level-of-abstraction fit

A child of *Structure beats Willpower*, as the approved spec places it: it turns one stated rule that lived in a memory note into routing and a hold. It sits in Building beside the model-map article it builds on, because the standards ratchet keeps The Root as its single founding article; a cross-family parent has precedent (*A Decision That Can Block Must Live Where the Checks Can See It*).

## 4. Signal vs authority compliance

Compliant: the article creates no authority here. In the spec, review records are signals and the outbound judge holds the blocking authority within stated floors (`docs/signal-vs-authority.md`). The operator keeps the one approval.

## 5. Interactions

The independent Building and Root family read found no contradiction or duplicated obligation with *Keep the Doorway/Model Map Current*, *Iterative Audit to Convergence*, *Judgment Within Floors*, *No Silent Degradation to Brittle Fallback*, *Framework-Agnostic* or *No Feature May Require a Purchased Service*, and no change of meaning in the root. The standards direction guard requires the operator's approving GitHub review on the final commit for the addition and the root's back-reference; that is expected for every constitution change.

## 6. External surfaces

None at runtime. The published constitution text changes; the shipped registry asset copies it at build time.

## 7. Multi-machine posture

Repo-tracked text; unified.

## 8. Rollback cost

A revert of the article, the root's back-reference, the regenerated hierarchy, the map rows, the count assertion and the two re-recorded family audits. The copied spec files are identical to PR #3323 and can stay.

## Second-pass review

**Reviewer:** independent cross-family reader, codex-cli on gpt-6.2-sol

Round 1 (both books, approved article, source messages): VERDICT NO, 4 must-fix. Three concerned the 2.0 book (its first Rule 124 row dropped approved requirements and added acceptance criteria; fixed there by carrying the approved sentences) and the 1.x quote's message pointer (added in the placement paragraph; the approved bytes are unchanged). One concerned the alignment map's result arithmetic: its categories already summed one short of the article count before this change (55 + 41 + 3 = 99 against 100); this change adds one aligned pair and leaves that pre-existing reconciliation as it was. Round 2: VERDICT NO, 2 must-fix, both here: the map's change row described removed 2.0 wording, and the placement paragraph overstated what the approval established; both fixed. Round 3 narrow recheck: VERDICT YES. Family reads: The Root with the article first placed there, then Building and The Root after the move: VERDICT YES. Report: `docs/specs/reports/frontier-design-review-family-review-2026-11-17.md`. Concur with the review.

The three quoted messages (141133/141213, 144319/4578964629224360, 144319/144458) were read from the lease holder's topic history on 2026-11-17 and match the quotes, including the curly apostrophe in 141213.

## Counterpart

instar-2 Rule 124 (branch echo/constitution-frontier-design-review), the master, which merges first.

## Test expectations changed

`tests/unit/standards-coverage-ratchet.test.ts`: article count 100 to 101.
