# Interaction family review after merging main: "Delight the User" beside "Every reference to a waiting ask carries the ask" (2026-11-27)

## What this review covers

Two changes reached the Interaction family separately and now sit together in one text:

- This branch (pull request 3486) adds the article **Delight the User** under *Operator-Surface Quality*, with the parent's acknowledgement and Applied-through line. Its family review is `docs/specs/reports/interaction-family-delight-after-main-merge-review-2026-11-19.md` (accepted).
- Main (pull request 3478, merged 2026-11-19) adds the named clause **"Every reference to a waiting ask carries the ask."** to *Agent Proposes, Operator Approves*. Its family reviews are `docs/specs/reports/waiting-ask-links-interaction-family-2026-11-18.md` and `docs/specs/reports/waiting-ask-links-interaction-family-merge-2026-11-19.md` (both accepted).

Each review accepted the family with only its own change in it. Neither saw the other, and each recorded a different family hash on 2026-11-19, so after the merge neither recorded hash is valid. This review reads the merged family as one text. Git merged the registry text without a conflict; only the audit record conflicted.

## Review

Round 1, author (echo:claude-code): merged main, confirmed the registry differs from the branch only by main's clause and from main only by this branch's article, and re-read the family.

Round 2, independent verifier (a separate read-only reviewer session, given the merged family and all three earlier reviews, not the author's conclusion): findings below.

### Questions asked

1. Do the two additions contradict each other, or does either change what the other requires?
2. Does either addition now duplicate or shadow another article in the family?
3. Did the merge change any wording of either addition, misplace either one, or leave conflict markers?
4. Anything else a careful standards reviewer would flag as a design finding in the merged family.

### Findings and disposition

Verdict of the independent verifier: accepted, no blocking finding.

1. **No contradiction.** *Delight the User* governs screens ("Every Instar screen a person sees"); the clause governs messages ("Whenever a message mentions something the agent is waiting on the person for"). Where they meet they support each other: the clause's fallback is a Work Board card, which is the screen *Delight* was earned from. The clause does not reach screens by its own words, so it cannot force a chat reply onto a screen against *Delight*'s "one obvious next action".
2. **No duplication or shadowing.** The clause is the later-mention sibling of "Every ask carries its links". *Delight*'s overlap with its parent's floors is answered in its own text ("the bar above that floor… a separate obligation, not a widening of the parent"), already accepted by its family review and unchanged by the merge.
3. **The merge is mechanically clean.** No conflict markers. Against the branch, the registry differs only by the clause line after "Every ask carries its links"; against main, only by this branch's *Delight* changes (hierarchy 46 → 47 relations, the parent's tree-node and Applied-through lines, and the article between *Dashboard UX Standard* and *Agent Proposes, Operator Approves*). No wording of either addition changed. The family has 20 articles.
4. **Gap in main's clause, not caused by this merge (non-blocking).** The sibling clause says "An authority grant links to its Approve/Decline page instead of a reply"; the new clause requires "the exact reply that settles it" for any waiting approval and does not repeat that exception. Read literally, a reminder about a pending authority grant would offer a chat reply that cannot settle it. Suggested follow-up sentence: "For an authority grant, the link to its Approve/Decline page stands in for the reply, as in *Every ask carries its links*." Not made here: it would change main's ratified wording inside a pull request about a different article. Carried as a follow-up for the owner of the waiting-ask clause.

Non-blocking notes from the verifier: a bare link carrying chat and message ids inside app message text could read as an internal id under *Delight*'s check (4), so apps should show such links as labelled tap targets; the two additions cite their ratification in different formats, both traceable.

## Coverage

`areas.Interaction.currentAreaSha256` on the merged tree is `7e113954464e9e06b9bcc99ddccb46d3cee4ecfd4c1806c2e6bae40de0417475`; 20 articles; the reference-resolution floor is unchanged at 8 of 13. The audit record is re-recorded at this hash, and this review is the evidence for it.

## What this review does not establish

That either gate judges real screens or messages correctly; both are advisory or attestation-only as written. Anything outside the Interaction family.

## Verdict

Interaction: accepted.

**Reviewer:** independent-verifier:claude-code-opus-5.5-fresh
