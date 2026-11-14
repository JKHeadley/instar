# Why merging stopped on a busy morning, and the fix (plain-English overview)

## What this is

Instar tests every change on our own machines before it merges. As a safety net, it also re-tests the main line itself after changes land, and it has an alarm: if main has gone three hours with something merged that no passing test of main has covered, stop merging until main is tested again. That alarm protects against quietly piling changes onto a broken main.

## What went wrong

The alarm kept its clock in a way that only worked on a quiet day. It reset the clock only when a test of main passed for main exactly as it stood at that moment. A test of main takes about 35 minutes. On 2026-11-14 changes were merging every 20 to 40 minutes, so every time a test of main finished, main had already moved on by one or two changes. The clock never reset. Three hours after the last restart the alarm went off, even though main had been tested and had passed several times in those three hours. From then on, changes that passed their own tests simply waited.

The faster the project merged, the more certain this was to happen. It is a limit on throughput that only shows up when throughput is good.

## What is new

When a test of main passes for a slightly older version of main, the clock now moves forward to the moment that test started, as long as the test began on main as it stood at that moment. Everything merged before that moment was in what got tested, so it is covered. A test that began on a version main had already moved past (for example a repeat of a failed test) does not move the clock, because something newer was already outside it. Only what merged after the test started is still waiting for the next one. The clock never moves backwards.

## What stays the same

If main really is not being tested (the tests fail to start, or keep erroring), the clock does not move and the alarm still goes off after three hours. A test of main that fails still stops merging at once, as before. The three-hour limit itself is unchanged.

## Safeguards

Three new tests. One runs eight tests of main back to back with a change merging during each one, more than four and a half hours in all, and checks the alarm stays quiet; it fails with the old behaviour. The second checks the alarm still fires three hours after the last test that covered main. The third checks that a test which began on an outdated version of main does not move the clock. The rule is a small separate function, tested on its own.

## What a reader needs to decide

Nothing. This restores what the alarm was meant to measure.
