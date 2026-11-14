# Deleted files and the decision-audit check, in plain English

## What this is

Every change to instar's code goes through a local gate at commit time. The gate writes a small record listing the files it looked at. When a pull request reaches the merge step, a second check compares the files the pull request changed with the files the records list. Any changed file that no record lists means the gate was skipped for it, and the merge stops.

The two halves disagreed about deleted files. The commit gate only listed files that still exist after the commit. The merge check counted every changed path, deletions included. So a pull request that deleted an in-scope file could never pass, however carefully it was built. Pull request #2821 deletes a script on purpose and has been stuck on exactly this.

## What already exists

The commit gate, the record it writes, the merge check, and a test suite for each. The merge check already fails when no record exists at all, and already fails for a changed file that no record lists. None of that changes.

## What is new

The commit gate now lists deleted files, the old side of a rename, and files whose type changed. A commit that only deletes code now goes through the gate; before, it skipped the gate entirely. Records written this way carry a new label in their "basis" field.

The merge check now excuses a deleted file in one narrow case: the pull request carries a record with the old label, which could never have listed it. Records with the new label get no excuse, so a deletion they leave out fails.

## The safeguards

A deleted file with no record at all still fails. A modified file that no record lists still fails. An unreadable record excuses nothing. New records never carry the old label, so the excuse fades as old branches land. It is not airtight: a pull request that touches an old record gets it too. That is fine, because this check spots a skipped gate and is not a security wall.

## What the reader needs to decide

Nothing. This is a small fix to our own build checks, a revert undoes it, and it changes nothing an agent or user sees at runtime. Builders will notice one thing: a deleted file must now be listed in the trace, and the refusal says so.
