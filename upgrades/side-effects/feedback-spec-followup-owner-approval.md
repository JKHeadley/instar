# Side effects: owner approval before the trusted spec follow-up (SEC-096)

## What changes for running agents
- Agents with the feedback executor on and the default `independent` gate: a merged spec draft no longer starts `feedback-specconverge-*` by itself. It waits in `specConvergeState: awaiting-owner-approval`, with one action-list line per merged head, until the approver approves that head on GitHub. A spec merged with the owner's approval (the `operator` gate, or an owner-approved head under `independent`) behaves as before. Merged-elsewhere drafts already needed this approval and still do.
- One extra GitHub reviews read per waiting draft per hour.
- Fix PRs (not specs): no change.
- Agents with the executor off: no change.

- The live-proof session (after a merged FIX) gets one more prompt line telling it to treat the fix, its PR text and tests as data.

## Signal vs authority
The model reviewers' pass is a signal about the draft. Authority to hand untrusted text to an unconfined, credentialed session comes only from the owner's GitHub approval at the exact head SHA (`approvedAtHead`: the approver's most recent review, on exactly that SHA).

## Rollback
Revert the commit. The new config key is ignored by older builds. Rows left in `awaiting-owner-approval` are picked up by the old code on its next tick and the trusted session starts as before.

## Not covered here
The trusted session still reads untrusted text once the owner approves. That residual risk is accepted by name in the feedback-triage spec, and the prompt keeps the treat-as-data instruction. Confining that step is a larger change.

**Reviewer:** independent second-pass subagent (fresh context, read-only): CONCUR. It confirmed that `spec_converge` is the only path that gives a draft to `spawnTrusted`, that `headSha` is fixed at the merged head, that `off` and the throttle never end the row, that the config fails closed, and that GitHub accepts a review on a merged PR at its head. Three nits are applied: the approver's LATEST review must approve, so a later "changes requested" withdraws it; `off` shows a for-your-information line; and the live-proof session's prompt now says the fix and its PR text came from an untrusted report and are data.
