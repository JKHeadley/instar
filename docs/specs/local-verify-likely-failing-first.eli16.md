# Finding out sooner that a change fails its tests (plain version)

Written 19 November 2026. It can be read with no other background.

> The one-line version: each test run starts with the few dozen test files most likely to fail, so a failing change is found out in a couple of minutes instead of 25 to 40, and the test machines get that time back.

## The problem in one breath

Every change to Instar is tested on our two computers before it can be merged, and a full test run takes 20 to 40 minutes. When a change fails, we only find out when a whole group of tests has finished. On the Studio, four of every ten test minutes go to runs that fail, and each takes 25 to 40 minutes to say so. Yet two thirds of failing runs fail on a single test file, and the same files fail again and again.

## What already exists

- **Three groups of tests** that run side by side: quick unit tests, slower integration tests, and end-to-end tests.
- **A rule that stops a run once one group has failed.** It only acts when that group has finished.
- **A second chance for unreliable tests:** a failed test file is run once more by itself before it counts.
- **An earlier attempt** at catching failures quickly, built in October. It tried to work out which tests a change affects, took too long to do that, and never ran a test in its trial. It is switched off.

## What this adds

Each group of tests starts with a small first part: the test files the change itself touches, and the files that failed most often in the last week. If one of them fails, and still fails when run again by itself, the run ends there. Otherwise the rest of the tests run as usual.

Nothing is left out. Every test still runs unless the run has already failed, and what counts as a pass or a failure does not change. Only the order does. A poor guess about which files to run first costs nothing; the run is simply as slow as it is today.

## The safeguards

**The verdict cannot change.** The same tests, the same second chance and the same stopping rule decide. A test checks that a run gives the same answer with this on as with it off.

**An unreliable test cannot end a run early.** It gets its second chance first, exactly as today.

**Passing runs must not get slower.** The cost is one extra start-up per group. If a passing run slows by more than a minute, it is switched off.

**It is off until the operator of the test line turns it on,** first on one machine.

## What it is worth

I tested the idea on history before proposing it: a list built only from the previous week's failures of other changes would have flagged 42% of the failing runs that followed. On that figure it frees about 205 machine-minutes a day, which is about 4 more merged changes a day. That is a projection from one week; the trial measures the real number.

## What ships when

One change, after review and the Chief of Staff's approval. Then a two-week trial with four measures: how fast a failing run says so, whether passing runs slowed, how many failures ended early, and how often a change needed a second run because a second fault was hidden behind the first.
