---
title: Disk Steward
description: Every machine watches its own disk, clears two known tool caches when space runs low, and posts a plain-words warning that names the machine before the disk fills.
---

On 7 November 2026 the Mac Studio's disk reached 95% full. The app refused an upload at the
media floor and nobody had been warned. The **Disk Steward** exists so that never happens again:
every machine that runs an agent server, standby machines included, looks after its own disk.

## What it does

- **Watches.** Every 15 minutes it measures free space, fits the growth over the last 24 hours and
  7 days, and forecasts how many days remain until the 5% floor where uploads stop.
- **Cleans first.** When the disk is low (under 15% or 100 GiB free) and cleanup is on, it clears
  two tool caches and nothing else: the npm download cache when it is over 5 GiB, and Xcode
  `DerivedData` older than a day. The cleanup runs in a separate, deadline-supervised child process
  so it can never freeze the agent, and it skips while an npm install or an Xcode build is running.
- **Then warns.** If space is still low after cleanup, it posts in the "Disk space (all machines)"
  topic: which machine, how much is free, how fast it is shrinking, what was cleared, what is being
  kept and why, and what to say to get more cleared. Under 10% (or 60 GiB), or when the disk is on
  track to fill within 3 days, it repeats more often. At the floor itself the warning always gets
  through.
- **One voice.** Only the machine holding the Telegram lease sends. It reads each machine's due
  post, writes the text from the numbers, and acknowledges it back, so a standby machine never posts
  on its own.

## Reading it

| Question | Read |
|---|---|
| How full is this machine? | `GET /disk-steward` — level, free bytes, forecast, last post, last cleanup, biggest folders |
| How full is every machine? | `GET /disk-steward?scope=pool` — each machine read live; an unreachable one is listed with its error |
| Clear a machine's caches now | `POST /disk-steward/prune` with `{ "machineId": "<id>" }` → 202 and a run id; `GET /disk-steward/prune/<runId>` for the result |

Someone replying "clear disk on \<machine\>" in the Disk space topic is the intended way to ask
for a manual clear. Disk posts follow the "Disk space" notification choice (quiet by default); floor
posts always come through. Every sample, post and cleanup is recorded in `logs/disk-steward.jsonl`.

## Components

- `DiskSteward` (`src/monitoring/DiskSteward.ts`) — the per-machine monitor: sampling, the growth
  fits and forecast, the warn / escalate / critical levels with hysteresis, the post cadence and
  retry backoff, and the cleanup breaker (cleanup stops after three runs that each free under 1%).
- `DiskStewardPoster` (`src/monitoring/DiskStewardPoster.ts`) — renders a due post from a machine's
  numbers in plain words, naming the machine and carrying a next step on every line.
- `diskStewardMain` — the deadline-supervised cleanup child, bound to the two cache roots.
- `src/server/diskStewardRoutes.ts` — the routes above, including the one-hop forward of a prune
  request to the machine it names.

## Switches

- `monitoring.diskSteward.enabled` — the watcher and the routes (on everywhere).
- `monitoring.diskSteward.prune.enabled` — automatic cleanup. Off for everyone; the update migration
  writes an explicit `true` on development agents only, which the operator can see and flip. The
  manual prune route still works while this is off; turning the whole steward off (and restarting)
  stops both.

## Safeguards

Only the two cache roots have a path to deletion: no worktrees, no agent memory or state, no files
of yours. Every rule keeps things when in doubt: a running build, an unreadable process list, a path
that resolves outside its root, a symlink. Samples, cleanup runs and the audit log are machine-local
by design; the pool view is read live from each machine.

## Two leaks fixed alongside it

The same change fixed the two leaks that filled the Studio. The agent worktree reaper
(`AgentWorktreeReaper`) now treats a linked `node_modules`, and a `dist/` whose every file maps
back to compiled source inside one build window, as regenerable instead of unsaved work, while a
checkout that anything else links into, that a running command names, or whose working-folder scan
failed is always kept. Local Verify sweeps its own orphaned run checkouts at the start of each run:
only folders it named and registered itself, that no process uses, through a non-forced
`git worktree remove`.
