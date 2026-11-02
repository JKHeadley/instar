## What Changed

- `GET /machine-maintenance?scope=pool` and `GET /machine-maintenance/lock-state?scope=pool`: one call from any machine returns every online machine's watch-only maintenance state (uptime, last practice run, holds, browser care) or lock reading, each tagged with `machineId` and `machineNickname`. A machine that is dark, offline, on an older version without the route, or unreachable is listed under `pool.failed` with a normalized reason, never a 500 and never a peer address or token. Read-only: the view carries `authority: "none"`, `canRestart: false`, `canStopWork: false`. Peer fetches go through the shared pool poll cache when it is on.
- The console Machines page now shows each machine's restart-care line on that machine's own card, and names the machines it could not read.
- A short awareness section reaches fresh agents and existing agents through the CLAUDE.md migration.

## What to Tell Your User

You can now ask me about restart care or screen locks for all your machines at once, not only the one I am on. Each answer names the machine, and if one of them cannot be read I say which one and why instead of guessing. The Machines page in the console shows the same per machine. It is still watch-only: nothing restarts or closes.

## Evidence

- Unit tests cover the merge (this machine, an answering peer, a failed peer, an older peer without the route, a dark self, id-shaped names) and every failure reason, and check no address, token or raw error text appears.
- An integration test serves both routes through the real server with real peer HTTP servers: an answering peer, an older peer (404), a dark peer (503) and a closed port.
- Console model tests cover per-machine lines and an older server that ignores the pool scope.

## Summary of New Capabilities

- `?scope=pool` on `GET /machine-maintenance` and `GET /machine-maintenance/lock-state`.
- Per-machine restart-care lines on the console Machines page.
