# Review: Attributed Statements Trace to Their Source (2026-11-05)

## What changed
`docs/STANDARDS-REGISTRY.md`: the new article *Attributed Statements Trace to Their Source* joins the Interaction family as a tree node under *Truthful Provenance — Speak Only as Yourself*, which names it back. It is the 1.x counterpart of 2.0 Rule 121 (instar-2). The rule text is the wording in 136110/139175, which the operator approved: "approved" [source: telegram 136110/139199 2026-11-05]. The alignment map gains the pair's rows. The article-count assertion moves from 95 to 97, with the second article in this pull request.

## What I checked
Two independent reads by GPT-6 Astra (a different model family), through the charter launcher, over the diffs of both books, the source messages, the case study and the note check. Standards lints: tree parentage, insertion placement, generated hierarchy, all clean.

## Findings
- F1, applied (round 1, must-fix, 2.0 text): the Rule 121 check cell made a report over stored statements a duty, which the approved text does not. Removed; in 1.x the report stays described as something the separate build plans.
- F2, applied (round 1, must-fix, 2.0 text): the 2.0 source note and changelog named a requirement without carrying the words. They now quote the requirement and the approval beside their pointers, as 1.x does.
- F3, not applied (round 1, note): "matched" could read as proof. The article keeps the one-reader limit; the fuller limits are in the note check.
- F4, applied (self, lint): first drafts tripped the false-claim check on "enforcement is" and the dangling-reference check on the unmerged spec path. **Applied through** now names the attribution paper trail spec in words and says it is not merged.
- F5, applied (round 3, must-fix, this report): it said the ELI16 keeps the one-reader limit, which it does not. Corrected here.
- Round 1 confirmed the rule bodies are byte-identical to the approved draft in both books (591 bytes), that the incident facts and the counts 190 = 118 + 50 + 5 + 17 match their records, and re-counted 96 articles, 121 rules and 51 aligned / 42 differs / 3 1.x-only.

## Verdict
Round 1 returned NO on F1 and F2, round 2 returned YES on the repairs, and round 3, on the final records, returned NO on F5 alone. The result of the read after that correction is on the pull request. The direction guard waits on the operator's approving review.

## Combined with the second rule (2026-11-05)
This pull request now also carries *No Feature May Require a Purchased Service*, so one review covers both articles. GPT-6 Astra read the combined diff: both rule bodies byte-identical to their approved drafts (591 and 349 bytes), every operator quote matching the log, 97 articles, 122 rules, 52 aligned / 42 differs / 3 1.x-only, and no change to the registry or map from merging main beyond the two articles. It returned NO on one must-fix in these records: current-change statements still said the count moved from 95 to 96, and a note still called R121's pair open. Corrected here; the counts in the sections above are the record of the earlier standalone reads. The result of the narrow recheck of that correction is on the pull request.
