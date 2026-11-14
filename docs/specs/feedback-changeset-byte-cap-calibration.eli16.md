---
title: "Feedback Change Set Byte Cap Calibration — Plain English"
parent-spec: "feedback-changeset-byte-cap-calibration.md"
---

# Why the feedback worker's small fix was rejected

The feedback worker found a possible repair for a high-priority Threadline problem, but the system rejected its work before anyone could review it. The error said its change set was too large. This did **not** mean the worker changed hundreds of lines. The executor counts the complete size of every file it touches. The worker needed to edit two large Instar integration files, and those two files already total about 4.36 MB on the current main branch. The existing limit is 4 MB. Any fix that edits both files fails even if it changes only one line in each.

# What changes

The full-file limit becomes 5 MiB for text files. Binary files still have the old 4 MiB total limit because a code review may not show their contents. The worker still cannot submit more than 200 changed files. The system still rejects special files, unsafe workspace writes and credential-shaped content. An independent reviewer still refuses a diff over 192 KB, and the published code still needs all test tiers and CI before merge. We are changing one number to fit the current size of the two files, with less than 1 MB of room for the accompanying tests and helper code. We are not approving the worker's candidate patch by changing the limit.

# How we will know it worked

A test will reproduce the actual two-file size and show that a small change to each is admitted. Tests will also prove that a larger change, a binary file over the old limit, and 201 files are still rejected. The real pipeline must then produce a fresh fix, pass independent review and exact-head checks, and merge. Until that happens, the queue is still falling behind; passing this calibration test alone does not count as a delivered field fix.

# If the calibration is wrong

The limit can be put back to 4 MB without migrating data. Any candidate already admitted still has to pass the same review and verification gates before it can merge. This adjustment does not affect agents that only send feedback or the people who receive their updates.
