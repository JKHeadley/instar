# The merge tool no longer chokes on large changes (plain-English overview)

## What this is

A two-line repair to the tool that performs merges (safe-merge), so it can read GitHub's answers about large changes.

## Why it matters

Before merging anything, the merge tool asks GitHub a series of questions: which checks ran, which files changed, who reviewed. It reads each answer through a pipe with a size limit. The limit was the default one, about one megabyte.

For most changes that is plenty. For a very large change, GitHub's answer to "which files changed, and how" is bigger than that. The read then fails outright, and the merge tool, unable to see the answer, refuses to merge and reports that it "could not verify" the checks. That message is true and useless: nothing was wrong with the checks, and nothing the author could do would change it.

This happened to a change on 2026-11-08, and again on 2026-11-15 to the commentable-documents feature. That feature had passed its full test for the fifth time and was cleared to merge. The automatic merger tried three times, got the same refusal three times, and gave up. Run by hand with a larger limit, the merge tool answered at once with the real reason it would not merge (one file missing from the change's paperwork), which the author could fix in a minute.

## What already exists

The merge tool and every check it performs. All of that is unchanged.

## What is new

The size limit on GitHub's answers is raised from about one megabyte to 64. That is far more than any real answer needs and is still a limit.

## Safeguards

- No check is skipped, weakened or reordered. The tool asks the same questions and applies the same rules to the answers.
- A test checks that each place in the tool that calls GitHub uses the larger limit, so the commonest way of bringing the problem back is caught.
- Going back is a normal revert.

## What it does not fix

When the tool truly cannot reach GitHub it still refuses with the same "could not verify" message. That is correct, but the message could say which question failed. Not part of this change.

## What a reader needs to decide

Nothing.
