## What Changed

- On a development agent, one agent per machine login now watches for a wedged machine: every 10 minutes (every 2 while anything looks wrong) it checks whether the system can still list its processes in time, whether processes are piling up stuck, whether the agent server is impaired or lagging while the processor sits idle, and, on Linux and WSL, whether a no-op launch through the system still works.
- When the same two of those signs hold for 20 minutes, it records a wedge candidate, asks a judge model once what it would do (leave it, gentle steps, restart in the next small-hours window, or restart now), and writes down the steps it WOULD have taken. Nothing is restarted, closed, dismissed or stopped: those steps are not built.
- One sign alone for 2 hours, or any candidate, marks the next maintenance window as due early, on paper only.
- `GET /machine-maintenance` now has a `wedge` block (and so does the pool view). An unread sign reads `unknown`, never healthy. Audit: `logs/machine-maintenance.jsonl`.
- A real operator notice for a confirmed candidate exists but is OFF unless `machineMaintenance.wedgeRestart.dryRunNotice` is set to true.

## What to Tell Your User

Nothing yet: this is watch-only evidence gathering on development agents, it sends no messages by default, and it cannot restart anything. If they ask whether a machine is stuck, the agent can now read real evidence instead of guessing.

## Evidence

- Unit tests drive the window rules on both sides of every limit (20 minutes, 3 observations, a 6-minute gap, 6-minute freshness, 2 hours for one sign, 6 hours since boot), the sampler's single-judge-per-condition rule across a restart and a maintainer takeover, the 24-hour judge budget, and the notice's default-off flag.
- An end-to-end test starts the sampler the way the server does, reads this machine's real process table, and gets a live `wedge` block from the real server.
- On macOS the GUI-path sign is not read yet (the canary app is not shipped), so a Mac can only form a candidate from the process table and the agent itself.

## Summary of New Capabilities

- `GET /machine-maintenance` → `wedge`: dry-run wedge detection, the judge's recorded proposal, and `forcedDueAt`.
