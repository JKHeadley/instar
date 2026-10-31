# Windows desktop local update handoff

## What Changed

When a WSL-to-Windows request times out while updating an existing desktop companion, Instar retries the same signed request from Windows. The old process must return a one-use update token and stop before Task Scheduler permits replacement. The diagnostic endpoint reports a fixed code if the local request also fails.

## What to Tell Your User

Mama PC can recover from a stale WSL bridge without asking the user to set up another remote access tool. The desktop remains unavailable until its live screen and controls pass verification. The user still opens the same Studio page and enters the dashboard PIN.

## Summary of New Capabilities

The authenticated diagnostic distinguishes a Windows-local preparation timeout, refusal, unavailability, and invalid reply. The installer can retry a signed companion handoff from Windows when the WSL bridge times out.

## Evidence

Before this repair, Mama PC's existing Windows companion returned `prepare-timeout` after eight signed requests from WSL and the installer stopped without replacing it. Windows CI now launches a real companion on localhost, proves the fallback signed prepare returns the one-use token, commits with that token, and observes the old process exit. Unit and HTTP integration tests cover the redacted diagnostic codes. Live Mama PC screen, input, and Stop verification remain the release acceptance check.
