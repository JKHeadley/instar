# Review: An Instar Agent Always Serves a Team (2026-11-10)

## What changed
`docs/STANDARDS-REGISTRY.md`: the new article *An Instar Agent Always Serves a Team* joins the Building family as a tree node under *An Instar Agent Is Always a Multi-Machine Entity*, which names it back. It is the 1.x counterpart of 2.0 Rule 123 (instar-2 branch echo/rule-123-team). The rule text is the wording in 141014/141482, which the operator approved: "Yes" [source: telegram 141014/141483 2026-11-10]. One sentence is put into 1.x terms: 2.0's "Extends #31 and #113 from machines to people." reads "Extends *An Instar Agent Is Always a Multi-Machine Entity*, and its cross-machine posture declaration, from machines to people." The title, the three roles, narrow-never-widen, the team-of-one and organization sentences and the checks are Echo's, and that message said so. The alignment map gains the pair's rows. The article-count assertion moves from 97 to 98.

## What I checked
One independent read by a different model family (codex-cli on gpt-6.1-sol) over the diff, the approved wording and the source messages, then a narrow recheck of the correction. Standards lints: tree parentage, insertion placement, generated hierarchy, all clean.

## Findings
- F1, applied (must-fix): the alignment map's article count still said 97 while the registry and map rows hold 98. Corrected to 98.
- N1, applied (note): the side-effects summary named the Building audit and report before they were in the diff. They are recorded in this change, after the read.
- The read confirmed the rule line matches the approved text byte for byte apart from the one permitted sentence, that every operator quote matches its source including the curly apostrophes, that no enforcement is claimed, that Echo's parts are marked, that the placement is defensible and the parent names the child back, and that the description of the existing team access (owner-signed grants, the agent can only narrow, an admin role) is true against `src/`.

## Verdict
First read: VERDICT NO on F1. The result of the narrow recheck is recorded in the side-effects artifact. The direction guard waits on the operator's approving review.
