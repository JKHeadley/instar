# The approve flow is now link → one click — in plain English

## What went wrong

Tonight a finished, fully-green PR could not be merged because the main branch
now requires an approval from someone other than the person who pushed it — a
rule that was tightened earlier in the evening. Fine: that is what a human
approval gate is for.

What was NOT fine is what the operator saw when they went to give that
approval: "waiting for someone to request your review", and no Approve button.
The PR had been opened with no reviewer requested, so GitHub's review UI
treated the operator as a bystander. They had to come back to chat, ask for
the review to be requested, wait, and go back. That is exactly the clunky
loop they had said they were afraid this process would fall into.

## Why it happened

The merge tool reads the repository's branch protection to decide whether a
review is required before it tries to merge. But GitHub has TWO places that
rule can live — the older "branch protection" settings and the newer
"rulesets" — and the tool only read the older one. The new rule lives in a
ruleset. So the tool believed the PR was mergeable, ran the merge, got
refused, and reported a generic "merge command failed". Nobody requested the
review, because nothing knew a review was the missing piece.

## What changed

1. **The merge tool reads the ruleset too.** If the base branch requires a
   human approval, it knows BEFORE it tries to merge.
2. **It requests the operator's review itself.** The moment it sees a
   required approval that is not there yet, it requests review from the
   operator (the repository owner by default; configurable) and stops with a
   clear, distinct answer: "approval required — review requested — here is the
   link". The link goes straight to the PR's Files tab, where the Approve
   button is.
3. **If the rule appears between the check and the merge,** the same thing
   happens on the way out: GitHub's refusal text is recognised, the review is
   requested, the link is handed back. Never a generic failure.
4. **The background merge watcher understands the new answer.** It posts one
   plain-language attention line with the link and does NOT retry — retrying
   cannot produce a human approval, so burning retry attempts would only add
   noise.
5. **The agent's own playbook says it plainly.** When the tool says
   "approval required", the agent's only job is to send the operator the link
   and merge when the approval lands. Never "can you request a review?"

## What it is not

It does not bypass the rule. The approval is the human's; this just makes
giving it one click instead of a round trip. The rule's decision about WHO
may approve is entirely GitHub's.

## How we know

Each new piece has a test that was made to fail by putting the old behaviour
back: ignore the ruleset's "last push approval" flag and the policy test
fails; remove the watcher's new branch and its test fails; revert the
playbook migration and its re-sync test fails. The refusal text GitHub
actually sent tonight is the literal fixture. This very change will be the
first PR to go through the new flow — so the operator will see whether it is
as smooth as it should be.
