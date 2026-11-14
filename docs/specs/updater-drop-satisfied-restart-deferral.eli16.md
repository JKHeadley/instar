# After an update, the server restarts once, not twice

## What this is about

When a new version of Instar is installed, the server has to restart to start using it. If something important is in progress (for example a 20-minute test run), the updater waits. It writes itself a note on disk, "restart onto version X when the work is done", so that the plan survives even if the updater itself is interrupted.

## What was wrong

The updater is not the only thing that can restart the server. A planned restart can be requested by another part of the system, the supervisor can restart a server that stopped answering, or the server can crash and come back. In all those cases the server comes back already running version X.

But the note was still on disk. Nothing had crossed it out, because the updater did not do the restart. So the freshly started server read "restart onto version X", and went about restarting itself again, onto the version it was already running.

That second restart costs more than a minute of downtime. While a restart is pending, the test line stops handing out new test runs, so the second machine sits idle until the first one finishes its run and the pointless restart is over. On 13 November 2026 this happened on the Mac Studio: it started on the new version at 11:20, and 46 seconds later announced it would restart for that same version.

## What changes

When the server starts, the updater now compares the note with the version this server process actually started with. If the server is already on version X, or on something newer, the note has been satisfied: it is crossed out and nothing restarts.

## What stays the same

- If the server is still on an older version than the note says, the note is kept and the restart happens exactly as before.
- The comparison uses the version recorded when the process started, not the version found on disk. The version on disk changes the moment an update is installed, so it cannot tell you what is running. If that record is missing, or a version number cannot be read, the note is kept, which is the old behaviour.
- How long the updater waits for work in progress, and what counts as work in progress, are untouched.

## What could go wrong, and why it is acceptable

The only new action is not restarting. The case where that would be wrong is a server that reports the new version while running old code. The record used here is taken once, at process start, from the code that was loaded, so a later install cannot change it. An independent reviewer was asked to check exactly that.

## What you need to decide

Nothing. This removes a wasted restart, and a pause of the test line, after every update whose restart had to wait.
