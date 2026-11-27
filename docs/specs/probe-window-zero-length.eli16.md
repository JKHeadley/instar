# A test that counts simultaneous workers stops miscounting — Plain-English Overview

> The one-line version: one of the checks on our own test machinery sometimes counted four workers when five were really running together, failed for no real reason, and took an unrelated change's test run down with it; the way it measures is corrected.

## The problem in one breath

Part of instar's test suite checks the machinery that limits how many tests run at once. One of those checks, added on 2026-11-12, confirms that a full test run started by the test line is allowed more than four workers. It does this with five tiny "probe" tests. Each probe writes down when it started, waits until it can see that all five have started, and then writes down when it ended. If all five were open at the same moment, five workers really ran together.

The flaw: the last probe to start sees all five start marks immediately, so it wrote its end mark in the same millisecond as its start. Its "open" period had no length at all, and the counting treats a period with no length as never open. Five workers running together were then counted as four, and the check failed. Whether that happened depended on a sub-millisecond coincidence, so it failed some of the time. On 2026-11-13 it failed the test run of an unrelated change (PR 3053): the failure output shows the five periods as 52, 59, 59, 52 and 0 milliseconds.

## What already exists

- **The probes** — five small test files used only by the checks on the test machinery.
- **The counting** — it takes each probe's start and end and works out the largest number open at once.
- **An earlier guess at this flaw** — when the check first failed once on 2026-11-12, it was put down to a probe running twice, and a guard was added for that. The failure output above shows that guess was wrong.

## What this adds

Each probe now stays open for 150 milliseconds after it sees that everyone has started, and only then writes its end mark. The last probe's period therefore has real length and overlaps the others.

## The safeguards

**It cannot make a limited run look unlimited.** When only four workers are allowed, the fifth probe cannot start until one of the first four has ended. Its start mark is written after that end mark, so the two are never open together, however long each stays open. The checks that confirm "no more than four" keep their meaning.

**The other probes were already open long enough.** They look for the start marks every 50 milliseconds, so they end within 50 milliseconds of the last start. Staying open 150 milliseconds covers that with room to spare.

**Only test code changes.** Nothing that ships to an agent is touched.

## What you actually need to decide

Nothing. This repairs a measurement in a test fixture; a revert restores the old behaviour.
