# A test run that is still working is no longer stopped at the hour mark — Plain-English Overview

## The problem

Instar's session watchdog can press Ctrl+C on a command it believes is stuck. It
already knows that test suites are slow, so it leaves one alone for its first
hour. The trouble is what happens at the hour mark: protection ended on the
clock alone, with no look at whether the run was healthy.

At that moment every other safeguard has already been passed. The watchdog's
deterministic backstop fires at thirty minutes, so any run past an hour is
beyond it; when the judge that decides "stuck or legitimate" cannot answer, or
answers "stuck" on a loaded machine, the run is interrupted. The decision is
arithmetic rather than a judgement.

That happened on 2026-10-20. A full suite, genuinely needing longer than an hour
on a saturated machine, was interrupted at sixty-one minutes. Worse, nobody was
told: the interruption is recorded in an internal log, and the harness that had
launched the suite reported a clean finish. An hour of work was thrown away and
the result looked like success.

The same hole had a second mouth. A `git push` that runs tests before pushing is
protected for the same hour; past it, the push is interrupted too. One happened
on the same machine the same night.

## What changes

Two things, one for each half of the failure.

**A run that is demonstrably working keeps its protection.** Past the hour, the
watchdog looks at how much processor time the run has actually used since it last
looked. A live test suite burns processor time continuously; a hung one — waiting
on a lock, on input that will never come, on a socket nobody answers — does not.
Where the time is still climbing, protection is held open. The measurement covers
the whole family of processes belonging to the run, because the `npm test` parent
mostly waits while its workers do the work, so the parent on its own looks idle
even at full tilt.

The extension cannot run forever. There is a hard three-hour bound, after which
the normal judge decides regardless. A run that is alive but using no processor
time is handed back to the judge exactly as before, and a machine whose process
listing gives no readable processor-time column behaves exactly as it did
yesterday — no evidence means no extension.

**An interrupted test run is announced.** Instead of a silent Ctrl+C, there is
one plain line: how long the run had been going, that nothing it had finished was
kept, and that it needs to run again. Previously the only trace was an internal
audit row that nobody reads unless they already suspect something.

## Safeguards and limits

The extension is narrow on purpose. It applies only to commands that already
match the known test-runner shapes, or to a command with one of those running
beneath it. It never grants permanent immunity: the three-hour bound ends it, a
run that stops using processor time loses it at the next poll, and an unreadable
measurement never grants it.

One deliberate piece of generosity: the first time the watchdog sees a run there
is nothing to compare against, so it allows a single poll — about thirty seconds
— before judging. Without that, a watchdog meeting an already-old suite on its
first poll (after a server restart, say) would interrupt it having measured
nothing at all. The grace is one poll, and the three-hour bound still applies.

Processor time is a proxy, and the honest limit is worth stating: a run stuck in
a loop that burns processor without finishing will be protected to the full three
hours. That is the trade — three hours of a wasted core against an hour of real
work destroyed and reported as success.

Rollback is a plain patch revert. Nothing is stored anywhere, nothing is sent
anywhere, and no operator action is needed.
