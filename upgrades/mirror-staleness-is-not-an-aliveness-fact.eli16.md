# A test that turned red at a specific minute, on every branch, with nobody touching anything — Plain-English Overview

## The problem in one breath

One end-to-end test checked that a reference file shipped inside instar was "not stale". That file was captured on 24 July, and the rule is that it goes stale after thirty days. So at **01:20 UTC today** — thirty-one days later — the test started failing everywhere at once. No commit caused it. The clock did.

## Why that is worse than an ordinary failure

Nothing in the code changed, so nothing in the code looks guilty. Every branch went red simultaneously, including the main one, which makes it read like an infrastructure outage rather than a test making a claim it had no business making.

And it blocked everything: nothing could merge, because merges wait on a green build.

## What the test was actually entitled to check

That the feature is **wired up** — that the reference file is found when the server really boots, that it carries a capture date, and that the "is it stale?" answer it reports agrees with the age it worked out.

What it was **not** entitled to check is whether that file happens to be under thirty days old on the day the test runs. That is a fact about how often we ship a fresh capture, not about whether the code works.

## What changes

The end-to-end test now checks the wiring and the internal consistency of the answer. The staleness rule itself moved to a test where the clock is a dial we set: at exactly thirty days it must report *not stale*, and at thirty-one it must report *stale*.

Both sides are pinned deliberately. A "fix" that made nothing ever stale would have satisfied a one-sided test while quietly deleting the warning the feature exists to give.

## The safeguard

Checked against deliberately broken code: with the staleness rule removed, the new test fails. So it is a test, not a decoration.

## One thing worth knowing separately

The shipped reference capture really is more than thirty days old now. That means a fresh install will correctly report it as stale — which is the feature working, not breaking. Whether to ship a newer capture is a release-cadence decision, and it is deliberately not made here: silently refreshing the date would have hidden the same information this change exists to preserve.

## What you actually need to decide

Nothing about the test. Separately, and not urgently: whether the shipped reference capture should be refreshed on a cadence so installs do not inherit a stale one.
