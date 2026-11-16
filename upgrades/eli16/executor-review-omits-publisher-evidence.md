# Executor review leaves out the publisher's own files — Plain-English Overview

## The problem in one breath

Yesterday's fix (#3209) made the feedback executor add two small files to each fix it publishes: a record that a quality gate ran, and a release note. Those files are needed for the GitHub checks to pass. But the two independent AI reviewers that must approve every executor fix are told that any change under the `.instar/` folder is a red flag, and the record lives there. So both reviewers rejected the first new fix for that reason alone. Every later fix would have been rejected the same way.

## What already exists

The confined session that writes the fix can't touch `.instar/` at all; the executor refuses such a change. And any release note the session writes is thrown away before publishing. So those two exact files can only come from the executor itself, written from facts it trusts.

## What this adds

Before the reviewers see the fix, the executor removes exactly those two files, the ones named after this fix's branch, from what it shows them. It also tells the reviewers, in its own words, which files it left out and why. Everything else is shown exactly as before. The rule that any other `.instar/` change is a red flag still applies.

## The safeguards

Only this fix's own record and note paths are left out, matched exactly. Any other file stays in. Who decides the merge and what must pass are unchanged. A new commit on the pull request is reviewed again from scratch.

## What ships when

Ships on merge. A revert undoes it.

## What you actually need to decide

Nothing.
