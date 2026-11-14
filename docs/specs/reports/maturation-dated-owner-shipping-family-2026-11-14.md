# Shipping family review — Maturation Path clause (h), a dark rung has a dated owner (2026-11-14)

## What changed in the Shipping family

One article: *Maturation Path — Test Agent → Development Agent → Fleet*.

- Its `**In practice.**` field gains clause (h), in two halves. **Dated owner:** every rung not yet reached names an owner (an agent by id, or the operator for a rung that advances on operator consent) and a review-due date, recorded on the feature's ladder entry at ship time. **Proven awake:** the carriers that re-surface a stalled rung (the maturation ladder, the Growth & Milestone analyst's incubation-expired rule, queue-pace) are proven awake by a positive control on the agent and machine running the trial before the rung's clock starts.
- Its `**Applied through.**` field: the existing unenforced sub-obligation for clauses (c) and (d) now names the dated-owner half of (h) as resting on author diligence under the same countdown (`STD-SUBCOUNTDOWN-maturation-bcd`, 2026-12-21). The proven-awake half is named as a separate unenforced sub-obligation, `STD-SUBCOUNTDOWN-maturation-h-awake`, 2026-12-21.
- Its `**Earned from.**` field gains the clause (h) incident.

No article is added, removed, renamed or re-parented. The other six Shipping articles' text is unchanged. Outside the family, `docs/constitution-alignment-map.md` row 75 records clause (h) as 1.x-only.

## Review

All seven articles in the family were read in full against the change: *Bug-Fix Evidence Bar*, *No Deferrals*, *Maturation Path*, *A Dark Feature Guards Nothing*, *Side-Effects Review Gate*, *Token-Audit Completeness*, *User-Facing Fixes Ship Live*.

Round 1, author (echo:claude-code). The PR as first pushed stated "a ladder entry whose next rung has no owner or no due date fails the build", but none of the 220 entries in `src/data/feature-ladders.json` carries a structured owner or review-due field and no test checks one. That was an enforcement claim with no guard. The pushed text also credited Justin with both quoted sentences, but the Telegram record (topic 139880) shows the first was Echo's wording at 18:49 UTC, which he quoted back at 19:06 UTC with his own sentence. Both were corrected before the independent review.

Round 2, independent verifier (a separate reviewer session with no access to the author's reasoning, read-only), first pass: did not concur. Twelve findings:

1. Clause (h) made a tracked commitment the record, which contradicts clause (d) (the maturation track is the home).
2. Clause (h) created an owner-plus-deadline obligation beside *No Deferrals*' deferral lifecycle, which states that a parallel follow-through mechanism is the one-obligation-several-owners defect.
3. Clause (h) overlapped clause (c)'s ship-time registration and carried a second countdown for it.
4. "Every rung" and "next rung" did not match, and "an agent, by id" did not fit rungs that advance on operator consent.
5. "None of the 220 entries has one" was misleading: owners appear as free text in some plans and drivers.
6. "ships staged, flip after a 4-week window" was presented as a quote and appears nowhere.
7. "A `developmentAgent` marker the agent did not then carry" was too broad: the marker was false on two of five machines.
8. The operator-directive label covered the proven-awake half, which was Echo's extension.
9. The new tracking id exists only in the registry (family-wide pattern).
10. Earned-from sat inline in In practice.
11. The proven-awake half should cross-reference *Bug-Fix Evidence Bar*.
12. The generated `src/data/standards-registry.md` held an older draft (gitignored, regenerated on build).

### Findings and disposition

- 1: resolved. The ladder entry is the record and is named as the maturation track's record for the feature; a commitment or message may carry only a reminder.
- 2: resolved. The dated-owner half is stated as *No Deferrals*' lifecycle applied on the maturation axis (close with evidence, re-date with a recorded reason, or go to the operator before the date; never expire silently), not a second one.
- 3: resolved. The dated-owner half is the content clause (c) registers, and it shares (c)/(d)'s countdown. The separate owner countdown was removed.
- 4: resolved. The owner may be the operator for an operator-consent rung. The next rung is dated at ship time and each later rung when the rung below it is reached, which matches the build check on the next rung. (A first wording of this fix contradicted itself. The third pass caught it and it was corrected.)
- 5: resolved. The text now says owners appear only as free text.
- 6: resolved. It now quotes the spec's frontmatter (`ships-staged`, "over a 4-week observation window") and cites the file.
- 7: resolved. "false on two of the agent's five machines at the time", checked against `logs/machine-coherence.jsonl`.
- 8: resolved. The source is scoped by half, and the proven-awake half binds only through the operator's approval of this text.
- 10: resolved. Moved into the article's Earned-from field.
- 11: resolved. It names the half as *Bug-Fix Evidence Bar*'s live-state proof, applied as a precondition of the clock.
- 9: noted, not a defect of this change. It is the same pattern as every other sub-obligation countdown in the family. `lint-documented-only-countdown` turns the date into a build failure.
- 12: noted. The file is gitignored and the build regenerates it.

Second pass: every registry finding was confirmed resolved, with the new factual claims verified against their sources. It found that the upgrade guide and ELI16 still described the old record (a tracked commitment) and that this audit file did not yet exist. Both were fixed. Third pass, over all eight changed files: one contradiction, introduced by the fix for finding 4, plus wording in the side-effects artifact. Both were fixed and this audit was re-recorded against the corrected text. The fourth pass's verdict is recorded in the side-effects artifact `upgrades/side-effects/maturation-dated-owner.md`.

Checks on the final text: `lint-documented-only-countdown` clean (40 sub-obligation countdowns, all unexpired). `standards-coverage --check` reports false-claims=0 and dangling=0. Single-governing-obligation, insertion-placement and code-backreference lints are clean. The Shipping reference-resolution floor is unchanged (5 of 7).

## What this review does not establish

It does not establish that the dated-owner fields or the positive-control record exist or work: both are named unenforced and due 2026-12-21. It does not establish whether instar-2's Rule 72 should carry the same clause. The alignment map records (h) as 1.x-only, and that question goes to the operator with this PR.

Not settled here: the direction guard. This is a change to a ROOT article's obligation, and `standards-coverage --check` requires the operator's approving review on the commit. That decision is the operator's, and this audit does not stand in for it.

## Verdict

Shipping: accepted.
