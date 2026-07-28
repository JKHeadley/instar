# ELI16 — you were being judged as the author of everything you merged

A pre-commit check looks at "the files you are committing" to decide whether new code that reads
outside systems ships with its required justification. It gets that list from the git index.

For an ordinary edit, the index *is* your change. **For a merge it is not.** Merging `main` into an
older branch stages every file that differs between your branch and `main` — hundreds or thousands of
them. The check then treats all of it as yours.

So you get refused for a rule broken by a file you have never opened, which does not appear in your
diff, in code somebody else wrote months ago. Measured on a branch based at 1 June: the merge stages
905 TypeScript files and the check refuses on two of them, neither touched by the merger.

That refusal is worse than annoying. It names a file you cannot see, so the two natural responses are
to go and edit someone else's code, or to reach for the flag that skips the check. Neither is what
anyone wanted.

**The fix.** While a merge is in progress git records the incoming side as `MERGE_HEAD`. Your actual
contribution to a merge is whatever differs from *that* — a file taken verbatim from the incoming
branch was not written by you. So during a merge the check now compares against the incoming ref
instead of the whole index.

**It does not go soft.** If you resolve a conflict, your resolution matches neither parent, so it is
still yours and still checked. There is a test for exactly that, and it fails if the fix is too
permissive. Outside a merge nothing changes at all — same list, same behaviour, and the 24 existing
tests pass untouched.

If the comparison itself fails for any reason, the check falls back to the old full list. That is the
stricter reading, so a failure can only ever over-report — it can never quietly let something past.

**Why this is the right layer.** A sweep finds 26 files on `main` that would trip this rule. Which of
them bites you depends on how old your branch is, because only files changed since your branch point
get staged. Adding justifications one file at a time is chasing a moving target; making the check
judge your own work fixes every version of the problem at once.
