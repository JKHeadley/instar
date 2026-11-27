# Feedback executor merge path — Plain-English Overview

## The problem in one breath

The feedback executor is the part of Instar that takes a bug report, writes a fix in a locked-down workspace, opens a pull request, gets it reviewed, and merges it. It has opened about a dozen pull requests and merged none. Four are open now. Three of them already passed their independent review, and they still sat for days.

## What already exists

The executor pushes its fix to a fork, opens a pull request, has two independent AI reviewers check the exact commit, and then calls the merge script, which merges only when every check is green. All of that stays as it is.

## What this adds

Three small repairs, each found by tracing a real stuck pull request:

1. Before merging, the executor removes a "hold" label from the pull request. If the label was already removed on an earlier try, GitHub says "label does not exist", and the executor read that as an error. So it never got to the merge again. Now "already removed" counts as done.
2. Every pull request must carry a small record proving a quality gate ran on its code. The executor's fixes never had one, because hooks are switched off in its workspace on purpose. The executor now writes that record itself, and the record says honestly which gate ran: the executor's own.
3. Every pull request that changes shipped code must carry a short release note. The executor's fixes never had one, and the merge script refuses any red check. The executor now adds a short note in fixed wording.

## The safeguards

Nothing about who can merge changes. A fix still needs both reviewers to pass its exact commit (or the owner's approval), and every required check must be green. The release note never copies text from the bug report or from the AI session that wrote the fix, so a crafted report cannot plant words in notes that every agent reads. Fixes are still published from a fork, never from a branch in the main repository, so code written from outside text never runs in CI with the repository's secrets before review.

## What ships when

All three ship together in one pull request, turned on at once. A revert undoes it.

## What you actually need to decide

Nothing. Fixes with failing tests still do not merge. They go through the existing retry, and are parked if they fail again.
