# Interaction family review after merging main — "Every reference to a waiting ask carries the ask" beside "Documents Stand on Their Own" (2026-11-19)

## What this review covers

Two changes reached the Interaction family separately and now sit together in one text:

- This branch (pull request 3478) adds a second named clause to *Agent Proposes, Operator Approves*: **"Every reference to a waiting ask carries the ask."** Its own family review is `docs/specs/reports/waiting-ask-links-interaction-family-2026-11-18.md` (accepted).
- Main (pull request 3473, merged 2026-11-19 09:39 UTC) adds the article **Documents Stand on Their Own** to the same family, ratified by the operator on 2026-11-18, topic 145097 ("Yes, to all"). Its family review is `docs/specs/reports/safeguard-benefit-and-standalone-docs-family-review-2026-11-18.md` (accepted). Its other new article, *A Safeguard Must Leave a Benefit*, sits in the Building family and is not touched by this branch.

Each review accepted the family with only its own change in it. Neither saw the other. This review reads the merged family as one text. No wording of either change is altered by the merge: git merged the registry text without a conflict, and only the recorded family hash differs.

## Review

Round 1, author (echo:claude-code): re-read the merged Interaction family, with attention to the two additions side by side.

Round 2, independent verifier (a separate read-only reviewer session, given the merged family and both earlier reviews, not the author's conclusion): see the findings below.

### Questions asked

1. Do the two additions contradict each other, or does either change what the other requires?
2. Does an approval ask written under *Documents Stand on Their Own* (four parts, followable with no session context) conflict with a reminder written under the waiting-ask clause (link plus one-line restatement plus the settling reply)?
3. Does either addition now duplicate or shadow another article in the family?
4. Did the merge change any wording of either addition, or misplace either one?

### Findings and disposition

Verdict of the independent verifier: accepted, no design finding.

1. **No contradiction.** The two additions govern different objects: *Documents Stand on Their Own* governs the decision document and the first approval ask; the waiting-ask clause governs every later mention of an ask still open. They point the same way: the clause's "restates the ask plainly … so the person can answer from that message alone" is the message-sized form of "followable by a reader with none of the session's context". Each leaves the other's ground alone: the clause leaves whether to remind to *The Agent Carries the Loop* and *Near-Silent Notifications*; *Documents* leaves the authority text with *Agent Proposes, Operator Approves*.
2. **No conflict between a four-part ask and a reminder.** The four parts belong to the original ask; the reminder links it, so the full ask is one tap away, and its restatement need only be "as short as it can be while still answerable". The four-part ask does not make the reminder clause redundant: only the clause reaches later mentions. Note (no change made): a very literal reader could treat a reminder that re-asks for a decision as an approval ask needing all four parts again; the required link answers that in substance. If the family is edited again, one sentence would close it: "the linked original carries the full ask under *Documents Stand on Their Own*".
3. **No duplication or shadowing** of *The Agent Carries the Loop*, *Near-Silent Notifications*, *Operator-Surface Quality* or the dashboard standard.
4. **The merge changed no wording and misplaced nothing.** Against the branch head, the registry differs only by main's additions; against main, it differs by exactly one line, this branch's clause, right after "Every ask carries its links". No conflict markers.
5. **Coverage.** `areas.Interaction.currentAreaSha256` is `610341e18c0a9f214ecf70f8ee172ed51abbf68b9cd82592c9e3f287806ed2ed`; 19 articles (18 before, plus *Documents*); floor enforced 8 of 13. The audit record had to be re-recorded at this hash, which this review is the evidence for. The direction-guard entries the script lists for the operator are main's two ratified articles and this branch's clause, which the operator's code-owner review of the pull request covers.

## What this review does not establish

That the outbound rule for the waiting-ask clause judges every real message correctly (measured during its development-agent period; an advisory nudge). Anything about the Building family, which this branch does not change.

## Verdict

Interaction: accepted.
