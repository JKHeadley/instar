# A list you can get onto but never off

## The situation

Some tests are excluded from the automated checks that run before code ships. That is sometimes
right: a test that fails randomly is worse than no test, because it trains everyone to ignore red.

The list of excluded tests has a way in and no way out.

Adding a test costs nothing — the file holding the list is treated as ordinary configuration, so
removing a guard from the build needs no review, no explanation, no record. And nothing ever checks
whether an excluded test could come back. The result is one-directional: the set of unchecked code
can only grow.

## This is measured, not theorised

Three tests were run three times each. All three had been excluded for reasons like "the assertions
don't match the current format" or "the detection is non-deterministic".

All three now pass, every time. They were repaired at some point and nobody re-armed them.

There is an earlier note in that same file about two other tests that had been excluded and **rotted**
while nobody was running them. So it fails in both directions — things break while parked, and things
get fixed while parked — and nobody notices either way, because nothing looks.

A fourth entry excludes a file that does not exist at all.

## What this adds

A re-check that reports which excluded tests now pass consistently, and which entries point at files
that are gone.

Two decisions shape it:

**It never re-arms anything.** Deciding a test can come back is a judgement about whether the original
reason still holds. A third of the list is excluded because a database component fails to build "on
this machine" — and the automated build runs on a different machine, where it may genuinely fail. A
tool that switched tests back on because they passed locally would be exactly the confident-wrong
answer this whole area keeps producing.

**It is cheap enough that it will actually get run.** Scanning for missing files costs nothing at all.
Only a small rotating handful of tests is actually executed per run, chosen so that repeated runs
cover the whole list over time. A tool nobody runs is a decoration.

## The bug this found in itself

The first version read the list with a simple search for quoted text. The list is heavily commented —
deliberately, because those comments are what stop the next person re-excluding a test on a wrong
label — and one comment contains an apostrophe.

That single apostrophe threw off the pairing of every quote after it. The tool invented entries that
were fragments of prose, and silently lost dozens of real ones. It confidently reported forty-two
missing files where there is one.

It was caught by running it. The fix reads the list line by line and skips comments, and a test now
feeds it a comment containing an apostrophe to make sure it stays fixed.
