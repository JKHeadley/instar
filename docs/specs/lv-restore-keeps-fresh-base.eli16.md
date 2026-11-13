# After a restart, changes are tested on today's code, not this morning's

## What this is about

Before a change is merged, the test line checks it: it takes the latest main code, adds the change on top, and runs the full set of tests. "The latest main code" matters. Main moves all day as other changes merge, including fixes for tests that fail for no good reason.

The test line keeps a waiting list on disk, so that a server restart does not lose it. For every waiting change the list remembers which version of main it should be tested on, and when that was last looked up. If it was looked up more than five minutes ago, or main is known to have moved, it is looked up again just before the test starts.

## What was wrong

When the server restarted and read the waiting list back, it did two things that together defeated that safeguard.

First, it replaced the remembered version of main with a value GitHub stores on each change: the version of main at the time the change was last updated. That value can be hours or days old. The test line already knows this value is not to be trusted (everywhere else it asks for main's current version), but this one place used it.

Second, it kept the "last looked up" time from before the restart, which was usually only seconds old, so the fresh look-up just before the test was skipped. And the note "main has moved" lives only in memory, so it was gone after the restart.

The result, on 13 November 2026: the first two tests after a restart ran two changes on top of the main code from seven hours earlier. Both failed. One failed on a faulty test that had been repaired on main that morning. About 50 minutes of machine time were spent producing two wrong answers.

## What changes

When the waiting list is read back after a restart:

- each change keeps the version of main the test line itself last looked up, never GitHub's old value;
- each change is marked "not looked up yet", so the version of main is always read fresh just before its test starts.

If the fresh look-up fails (GitHub unreachable), the test uses the remembered version, which is at most as old as the restart.

## What stays the same

- A change that had already been handed to the second test machine before the restart keeps exactly what it was handed over with, because its result is matched against that.
- Changes that were closed, or changed, while the server was down are still dropped from the list as before.
- Nothing changes while the server is running normally.

## What could go wrong, and why it is acceptable

The first test after a restart now waits for one extra look-up (well under a second) before it starts. That is the same look-up every other test already does.

## What you need to decide

Nothing. This stops the first tests after every restart from failing against outdated code.
