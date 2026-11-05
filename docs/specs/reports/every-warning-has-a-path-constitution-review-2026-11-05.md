# Review: Every Warning Has a Path (2026-11-05)

## What changed
`docs/STANDARDS-REGISTRY.md`: the new article *Every Warning Has a Path* joins the Interaction family as a tree node under *Operator-Surface Quality*, which names it back. It is the 1.x counterpart of 2.0 Rule 122, with the wording Justin approved: "On the decision: yes" [source: telegram 134088/139281 2026-11-05], answering 134088/139279. The alignment map gains the pair.

## What I checked
The approval and the wording in the logged messages themselves. Two independent reads by GPT-6 Astra of this diff, and two of the 2.0 change. Standards lints: tree parentage, insertion placement, generated hierarchy, all clean.

## Findings
- F1, applied: **Applied through** overstated the console check. It checks that a declared path is present, and accepts an exemption with a written reason; it does not prove the warning is connected to that path.
- F2, applied: the first-screen test checks document order, not viewport layout.
- F3, applied as a stated limit: several health actions open a general page such as Accounts, not the exact item. The rule asks for the exact item, so the article says the checks do not certify this.
- F4, 2.0 side, applied: an unsourced statement about the operator now quotes him with its source.

## Verdict
Converged: the final reads of both books returned YES and no finding is open. The direction guard waits on the operator's approving review, which is the approval this change asks for.
