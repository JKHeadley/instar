# Windows desktop local update handoff

## What changed

When a WSL-to-Windows request times out while updating an existing desktop companion, Instar retries the same signed request from Windows. The old process must return a one-use update token and stop before Task Scheduler permits replacement. The diagnostic endpoint reports a fixed code if the local request also fails.

## User impact

Mama PC can recover from a stale WSL bridge without asking the user to set up another remote access tool. The desktop remains unavailable until its live screen and controls pass verification. The user still opens the same Studio page and enters the dashboard PIN.

## Verification

Windows CI runs a real companion and proves signed prepare, token-bound commit, and process exit. Unit and HTTP integration tests cover the redacted diagnostic codes; live Mama PC verification remains the release acceptance check.
