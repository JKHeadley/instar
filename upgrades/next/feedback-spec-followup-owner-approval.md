# Spec drafts from outside feedback need the owner before the trusted step

<!-- bump: patch -->

## What Changed

SEC-096. Under the default `independent` review gate, a spec draft that the feedback executor wrote from outside (untrusted) reports could be merged on the two model reviewers' word alone. After the merge, the executor started a TRUSTED session (no confinement, the agent's auth kept) to converge the draft, and that session's prompt said the operator had reviewed it. No spec follow-up had run yet.

The trusted step now starts only when the approver's most recent GitHub review approves the exact merged head of the draft, however it was merged. Until then the row waits as `awaiting-owner-approval`, GitHub is checked at most once an hour, and the owner's action list carries one line with the link. A new setting, `feedbackFactory.execute.specFollowUp`, takes `owner-approved` (the default) or `off`. With `off`, the step never starts and the owner sees a for-your-information line. Any other value counts as `owner-approved`. The session prompt now says the operator approved the merged draft on GitHub, which is now true. The live-proof session that runs after a merged fix is now told to treat the fix and its PR text as data.

## What to Tell Your User

- **Spec drafts wait for you**: "When I draft a plan from outside feedback and my reviewers pass it, I no longer start working on it with full access until you approve that exact draft on GitHub. You will see it in your list with a link."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Owner approval before the trusted spec step | Automatic; approve the merged spec PR on GitHub |
| Switch the trusted spec step off | Set `feedbackFactory.execute.specFollowUp` to `off` |

## Evidence

- Unit (`tests/unit/feedback-factory/execute-service.test.ts`): a spec draft merged on the independent review alone does not start the trusted session. An approval of another commit, or by another account, does not count. The owner's approval of the head starts it on the next hourly read, with the truthful prompt. An approval later followed by changes requested does not count. `off` shows its line. With `specFollowUp: off` nothing starts even with the approval. The earlier owner-approved and merged-elsewhere tests still pass.
