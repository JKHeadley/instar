# Review: No Feature May Require a Purchased Service (2026-11-05)

## What changed
`docs/STANDARDS-REGISTRY.md`: the new article *No Feature May Require a Purchased Service* joins the Building family as a tree node under *Framework-Agnostic — and Framework-Optimizing*, which names it back. It is the 1.x counterpart of 2.0 Rule 122 (instar-2). The rule text is the wording in 136110/139251, which the operator approved: "Yes, on the new rule" [source: telegram 136110/139311 2026-11-05]. Its last sentence and the title are Echo's, and that message said the sentence was. The alignment map gains the pair's rows. The article-count assertion moves from 95 to 96.

## What I checked
One independent read by GPT-6 Astra (a different model family), through the charter launcher, over the changes in both books and the source messages. Standards lints: tree parentage, insertion placement, generated hierarchy, all clean.

## Findings
- F1, applied (self, before the completed read): the alignment map's article count still said 95. An interrupted first launch of the read pointed it out; corrected to 96 before the completed run.
- N1, kept (note): the map's list of 26 2.0-only rules does not include R121, whose 1.x pair #2812 is still open. The count row says so by name.
- N2, kept (note): `build-register --check` in 2.0 fails on the real clock at a deadline this change does not touch; the 2.0 change review records it.
- The read confirmed the rule bodies are byte-identical to the approved draft in both books (349 bytes), that every quote matches the log, that no enforcement is claimed, and re-counted 96 articles, 122 rules and 51 aligned / 42 differs / 3 1.x-only. It called the parent defensible and said a root position would be too; moving it would fix nothing.

## Verdict
VERDICT YES, 0 must-fix, 2 notes. The direction guard waits on the operator's approving review.
