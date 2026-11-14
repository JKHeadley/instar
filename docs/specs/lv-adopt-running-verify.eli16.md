# A running test survives a server restart — Plain-English Overview

> The one-line version: when the server dies while a test run is in progress, the restarted server now keeps that run and collects its result; before, it killed the healthy run and started the same half-hour test again.

## The problem in one breath

Every change to instar must pass a full test run of about 25 to 30 minutes before it can merge, and each machine runs one at a time. The run happens in its own helper process. On a Mac that helper is started in a way that makes it independent of the server, so when the server dies the helper carries on testing.

The trouble was what the server did when it came back. It found a note saying "a run was in progress", found the helper still alive, confirmed the helper was its own, and then killed it, on the reasoning that a run from before the restart must be an orphan. Then it started the same run again from the beginning. On the night of 2026-11-13 the server's supervisor restarted it about seven times because it had stopped answering, and each restart threw away whatever run was in progress: up to half an hour of testing each time, on a line where a dozen changes were waiting.

## What already exists

- **The in-progress note** — a small file written when a run starts: which change, which exact version of it, a secret token for this run, and the helper's process number.
- **The identity check** — after a restart the server looks at the helper's own command line. If it carries this run's token, the helper is this server's run and not some other program. Today this check is what permits the kill.
- **The result file** — written by the helper as its very last step.
- **The waiting line** — saved to disk, with the running entry marked as running.

## What this adds

After a restart, a run that is still alive, passes the identity check, and was built for exactly this version of the test machinery is kept. The server puts its entry back as "running", waits for the helper to finish, and then reads the result file and records the verdict, the same way it does for a run it started itself.

## The new pieces

- **A list of reasons not to keep a run.** The run is stopped and started again, exactly as before, if any of these holds: the feature is switched off; this machine is only lending its capacity to another machine; the run is the health check of the main branch (those are not saved in the waiting line); the test machinery on disk has changed since the run started; the run's own input file is missing or describes a different change, version, starting point or machinery than the note and this server; the run is a hand-off from another machine; or it started longer ago than a whole run is allowed to take.
- **Matching it to the line.** The run is kept only if the saved waiting line still has its entry, the change is still open, and its version has not moved. Otherwise it is stopped.
- **Noticing the end.** The server has no direct line to a helper it did not start, so every 30 seconds it checks: has the result file appeared, or has the helper gone? Either means the run is over. If the helper has gone without leaving a result, the run is treated as crashed and tried again.
- **A time limit.** A kept run is not waited on for ever. Past the longest a run may take, plus five minutes (about three hours from its start, a deliberately generous limit against runs of 25 to 30 minutes), it is stopped and treated as crashed, so the line cannot be held up by a process that is stuck.
- **A switch.** `monitoring.localVerify.adoptRunningRun` turns this off (it is on unless set to false).

## The safeguards

**The verdict comes from the same place as always.** It is whatever the helper wrote in its result file, whose name contains this run's secret token. Keeping a run adds no new way to produce a verdict.

**A kept run's verdict is checked against its entry.** Before it is recorded, the result must be for the same change, the same version of it, the same starting point and the same test machinery as the entry it was kept for. If not, it is treated as a crash, not a pass or a fail.

**Only at start-up.** A run can be kept only during the server's start-up, where the waiting line is rebuilt. If the identity check cannot be done then (the machine is too busy to answer), the run is stopped later as before, never kept late. A reviewer found that keeping one late would have left the line stuck; a test now holds this.

**An unreadable answer never ends a run.** If the machine is too busy to say what the helper process is, the server keeps waiting; it does not conclude the helper is gone.

**Merging is unchanged.** A recorded pass goes through the usual merge step and all of its checks.

## What is not fixed by this

A run that had already finished while the server was down is still run again (its result is not picked up). The main-branch health check and runs lent to another machine are still stopped and restarted. A planned restart still stops a run that is in the middle. These are tracked under the same commitment (CMT-1718).

## What you actually need to decide

Nothing. The change is reversible two ways: the switch, or a revert. No stored data changes shape.
