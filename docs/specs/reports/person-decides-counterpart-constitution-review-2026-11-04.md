# Review: The Person Decides; the Agent Does the Rest (2026-11-04)

## What changed
`docs/STANDARDS-REGISTRY.md`: the new article *The Person Decides; the Agent Does the Rest* joins the Interaction family as a tree node under *Agent Proposes, Operator Approves*, which names it back. It is the 1.x counterpart of 2.0 Rule 120 (instar-2 PR 190), from Justin's 2026-11-03 direction that the person only ever approves, asks for changes or supplies credentials. The alignment map gains the pair's rows. The article-count assertion moves from 94 to 95.

## What I checked
An independent read by GPT-6 Astra of the 2.0 change first. It found that 1.x carried only parts of Rule 120, so a "none" counterpart would be dishonest, and it proposed the placement and wording this change follows. A second read of this final diff checked it against the 2.0 rule book. Standards lints: tree parentage, insertion placement, generated hierarchy and countdowns, all clean.

## Findings
- F1, not applied: *Never a False Blocker* allows genuine physical actions and CAPTCHAs, a literal tension with the narrow boundary on the person's part. *Self-Unblock Before Escalating* already has that tension with the same ladder; this change imports Rule 120 rather than resolving it, so the books stay aligned.
- F2, not applied: *Sovereignty* keeps "if it's the human's, ask". That is conflict 5 in the alignment map, and the map row for this pair says it is unchanged.
- F3, applied: the overview said agents "behave the same" until the checks are built; it now says no runtime enforcement changes, since an unenforced rule can still shape behaviour.
- F4, applied: the side-effects artifact said "same wording" as Rule 120; it now says "same obligation", since the 1.x text drops the executive-assistant analogy and adds "within the authority granted to it", which 2.0 Sovereignty already imposes.
- Counts and map rows were independently re-counted: 95 Rule-bearing articles, 120 rules, 50 aligned / 42 differs / 3 1.x-only.

## Verdict
Converged: both reads returned YES and no finding is open. The direction guard waits on the operator's approving review, which is the approval this change asks for.
