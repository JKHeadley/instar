# A gate refused every push, and told everyone to fix it the wrong way

## What was broken

There is a check that runs before code is pushed. Its job is: *if the release notes say this ships a
fix, make sure someone wrote a review of what that fix might break.*

Sensible. But when there were no release notes in flight — the normal state right after a release
goes out — it fell back to checking the notes for the release that had **already shipped**. And it
demanded a review file named after that version number.

That file never exists. Review files are named after the change, not after the version, and the
release process has never created a version-named one. So the check asked for something that cannot
be produced, on a release that had already shipped and already been reviewed, and it did this on
**every push from a clean tree**.

## Why this is worse than a false alarm

A false alarm you can ignore. This one came with instructions.

The message said "no matching side-effects review artifact found" — so three separate times, someone
did the obvious thing and hand-wrote the missing file. Those files are still in the repo, and two of
them openly say what they are: *"This file exists so the repo state matches the gate's documented
post-release expectation."*

That is a gate teaching people to write junk to satisfy it. The junk then looks like evidence of
review, when it is evidence of a workaround.

Both of those files also claim the underlying problem "remains logged" in an issue ledger, under a
specific tracking key. It is not there. The ledger holds 163 issues and none of them is this one. So
the problem was declared tracked, was not tracked, and recurred a third time today — which is exactly
how a thing recurs.

## What changed

The check now only runs against release notes **this push is actually shipping**. If there are no
notes in flight, there is nothing for it to check, and it says nothing.

Nothing was weakened, and this is the part worth checking rather than taking on trust:

- The per-change requirement still lives where it always did — the check that runs when you
  **commit**, which refuses any in-scope file without its plain-English summary and its
  side-effects review. That one is untouched.
- A separate check still refuses a push that changes shipping code without adding release notes at
  all, and it names the actual fix.
- And with notes in flight, the review requirement still fires. There is a test for exactly that,
  because the easy mistake here would be to trade a false alarm for a missed one.

The message it prints when it does fire now names the right remedy — a review file named after the
change — and says explicitly not to create a version-named file.

## How I know it works

By breaking it on purpose. The three new tests were run against the **old** code first, and all
three failed. Then against the new code, where all nineteen pass. A test that has never failed is a
test that has never proved anything.
