# The test of the main line can run on either test machine

## What this is

Instar tests every change before it is merged. It also tests the main line itself from time to time, to be sure the merged result still works. With two test machines, one of them (the coordinator) hands out the work and the other (the helper) runs what it is given.

## What went wrong

Only the coordinator could run the main-line test. The helper was allowed to test changes, never the main line. So when the main-line test was due, it waited for the coordinator's own slot even while the helper sat free, and while it ran it took the coordinator away from the changes waiting in line. On 2026-11-17 the main-line test waited 82 minutes on average, and it used 426 minutes of the coordinator in one day.

## What changes

The main-line test can now go to whichever machine is free first. This is a setting, and it is off until you turn it on (`monitoring.localVerify.mainOnPeers` on the coordinator, read live).

- The same fairness rule applies on both machines: while the main line is healthy, waiting changes go first until the main-line test has waited its 90 minutes. The helper is not handed the main-line test at every chance.
- The helper is only given the main-line test while the main line is healthy. If the helper's test fails, the main line is marked as under suspicion and the coordinator repeats the test itself. Only the coordinator's own failing test can mark the main line as broken, so a helper with a broken setup cannot stop all merging by itself.
- Only one main-line test runs at a time, on either machine.
- A newer version of the main line never stops a main-line test that is already running on the helper. It waits behind it, the same as it does on the coordinator.
- The helper checks for itself that the version it is asked to test really is part of the main line before it starts.
- If the helper's test fails, it sends back which test files failed, so the coordinator can still tell a repair from a change that is bound to fail.
- If the coordinator restarts while the helper is testing, it picks the same test back up afterwards.
- If the helper stops answering for five minutes, the coordinator takes the test back and runs it itself.
- If the helper three times in a row cannot confirm the version it was asked to test, it gets no main-line test for 30 minutes and you are told.

## What you will notice

Nothing until you turn the setting on. With it on and two test machines, the main-line test starts sooner and changes waiting to be tested get the coordinator back more often. With one machine, or with the setting off, nothing changes.
