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

Nothing is left out. Every test still runs unless the run has already failed, and what counts as a pass or a failure does not change. Only the order does. A poor guess about which files to run first changes no answer; the run is as slow as it is today, plus a small start-up cost that the trial measures.

## The safeguards

**The rules for the verdict do not change.** The same tests, the same second chance and the same stopping rule decide. One caveat, stated plainly: a badly written test whose result depends on which other tests ran just before it can change its result when the order changes. That is already true today. Nothing cheap can prove it never happens, so during the trial each machine keeps a daily list of anything that looks lopsided between the runs with the new order and the runs without, and each item on it must get a written finding within 3 days (the section at the end says why this replaced repeating runs the old way).

**A pass still needs every test.** The first part can end a run early as failed. It can never end one early as passed.

**An unreliable test cannot end a run early.** It gets its second chance first, exactly as today.

**Passing runs must not get slower.** The cost is one extra start-up per group. If passing runs are more than a minute slower on two days in a row, it is switched off.

**It is off until the operator of the test line turns it on,** first on one machine.

## What it is worth

I tested the idea on history before proposing it. Replaying the exact rules, a list built only from the previous week's failures of other changes, plus the files the same change failed on last time, would have contained the failing file in about half of the failing runs that followed (53%, as an upper bound). If 40% to 50% of failing runs end in the first couple of minutes, the two machines get back 200 to 245 minutes a day, which is about 4 more merged changes a day. That is a projection from one week; the trial measures the real number by running every other test run the old way for comparison.

## What ships when

One change, after review and the Chief of Staff's approval. Then a two-week trial with four measures: how fast a failing run says so, whether passing runs slowed, how many failures ended early, and how often a change needed a second run because a second fault was hidden behind the first.

## Changed after the first try (2026-11-19)

The first trial ran for 36 minutes on one machine and switched itself off. The cause was the safety check I had designed, not the idea. After some runs the machine ran the same change a second time, in the old order, to see whether the answer was the same. That second run took the machine out of the line for 18 minutes while 15 changes waited, and it ended the trial because one unreliable test failed in the first run and passed in the second. Two runs of the same change often disagree like that, for reasons that have nothing to do with the order of the files.

So the second runs are gone. What protects the answer now:

- **The rule that matters is built in and tested:** a run is only ever recorded as passed after every test passed. Running some files first can end a run early only as failed.
- **Each run writes down one line** about what failed and whether it was in the first part. Once a day the machine lists anything that looks lopsided between the two groups, and any time the main branch went red (the full test run on the shared code failed twice after a change was merged into it) following a change that had passed with first parts. Each such "suspect" must get a written finding within 3 days; one that is late is shown as overdue. One confirmed case of the order changing an answer ends the trial on both machines.
- **Two automatic limits on cost stay:** passing runs more than a minute slower, or runs hitting their time limit more than twice as often, on two days in a row, switch it off.

What this gives up: proof, run by run, that the answer is the same. If a change ever passed wrongly because of the order, it would be noticed the way any wrongly passed change is noticed today: the main branch goes red after it is merged, and someone traces why.
