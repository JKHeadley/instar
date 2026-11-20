---
title: "Server memory ceiling: the lifeline stops a runaway agent server"
slug: "server-memory-ceiling"
author: "echo"
parent-principle: "Bounded Blast Radius"
eli16-overview: "server-memory-ceiling.eli16.md"
status: "draft"
approved: false
---

# Server memory ceiling

## Problem

On 2026-11-20 the Laptop's Echo server (Node 26.13.0) grew to 10-37 GB six times in 9 hours
(post-mortem A3; kills at 00:59, 01:16, 06:08, 08:32, 09:36, 09:47 PST in the Laptop's local
watchdog log, RSS read by `ps -o rss=`; the matching `sample` report shows a 21.2 GB physical
footprint at an 18 GB RSS reading). The trigger was Node 26's HTTP/2 fetch path, now pinned to
HTTP/1.1 (PR #3523). The general gap is that nothing in instar bounds the memory of its own server:

- The lifeline's supervisor (`src/lifeline/ServerSupervisor.ts`) restarts a server only when
  `/health` fails 6 times (~60 s), and defers that up to 30 checks (~5 min) when the box is
  CPU-starved, which a balloon causes by pushing the machine into swap.
- Its restart path (`handleUnhealthy()`) has branches that do not kill the server at all: the
  circuit breaker open (kills only at retry slots), the 5-minute cooldown after
  `maxRestartAttempts`, a planned restart / maintenance wait, and a 5-80 s backoff before the kill.
  At gigabytes a minute each of these is the incident again.
- The circuit breaker needs 20 failures in an hour and is reset by any healthy tick; a server that
  balloons every few minutes and is healthy between balloons never trips it.
- The only stop was a hand-written launchd script on the Laptop (added 2026-11-19), killing above
  8 GB. Other machines and agents have nothing.

## Decision points touched

| Decision | Classification | Basis / evidence |
|---|---|---|
| Server memory at or above the ceiling on two fresh readings, or once at 1.5x → kill the server now | invariant | basis: irreversible-consequence; evidence: past the ceiling a runaway grows by GB/min (Laptop 2026-11-20: 10-37 GB, swap exhaustion, every other agent on the machine stalled); the input is one physical measurement, not competing liveness signals; a second fresh reading rejects a single transient spike, and 1.5x covers the starved case where ticks arrive minutes apart |
| Default ceiling = min(8192 MB, 50% of physical RAM), clamped like a configured value | invariant | basis: external-constraint; evidence: healthy server memory measured at 0.7-2 GB on the Laptop and the Studio on 2026-11-20 (4x headroom at 8 GB); on a machine with 16 GB or less, half of RAM is where swap starts hurting every other process; operators can set another value |
| Ceiling clamped to [3072 MB, 90% of RAM]; disabled with one log line when 90% of RAM < 3072 MB | invariant | basis: irreversible-consequence; evidence: below 3072 MB a healthy server (up to 2 GB measured) would be killed in a loop; above 90% of RAM the kill would come only after the machine is already swapping; a machine under ~3.4 GB has no value that is both safe for the server and below swap |
| Escalation notice after 3 memory kills inside 6 hours | judgment-candidate | floor: kills always happen and are always recorded; the notice is the only variable and its default is to say less; arbiter: the owner, who reads one notice per episode; basis: the 2026-11-20 kills above reach three inside 6 hours at 06:08 (00:59, 01:16, 06:08), which is the single notice for that day's episode; a single self-healed kill does not notify |

## Design

### 1. Measurement (every supervisor tick, 10 s)

The probe starts at the top of `runHealthTick`, after the `detached` and `slept` early returns and
before the startup-grace return, and runs alongside (not after) the `/health` probe. It is async end
to end and has one 8 s deadline for the whole probe; on expiry outstanding commands are killed and
the reading is `unknown`.

1. **Session and pane**: async `tmux list-panes -t =<session> -F '#{session_id} #{pane_pid}'`
   (timeout 5 s), every probe. The tmux session id binds the reading to this exact session.
2. **Process tree**: async `pgrep -P` walk from the pane pid (depth at most 4, at most 200 pids),
   then `ps -o pid=,rss=,comm= -p <list>` (no arguments, so its size is bounded by the pid count),
   and only for the processes whose `comm` basename is `node`, a second
   `ps -ww -o pid=,args= -p <node pids>` (`maxBuffer` 1 MB). An unrelated process with huge
   arguments therefore cannot make the server's reading fail. The pane pid itself is included, so a launcher that `exec`s node is covered.
3. **The server** is the process in that tree whose `comm` basename is `node` (macOS prints the
   full path, e.g. `.instar/bin/node`) and whose arguments contain
   `cli.js` followed by `server start` and `--foreground`. Being inside this session's tree scopes it
   to this agent, so a server the lifeline adopted after its own restart (no spawn in this lifeline)
   is found the same way. The pane shell (`bash -c`) and the `tee` subshell are not node. If
   several match, the one with the most memory counts.
4. **Memory** = RSS from that `ps`. On macOS, RSS falls when pages are compressed or swapped out,
   which is the state a runaway causes, so every third probe (30 s) also reads the physical
   footprint, and EVERY probe reads it while the last reading was at or above 75% of the ceiling
   or a first breach is pending (`top -l 1 -pid <pid> -stats mem`, measured ~0.3 s; values like `21G`, `512M+`,
   `1024K` parsed with their suffix, a parse failure drops the footprint for that probe). A
   reading is `{ pid, sessionId, at, rssMb, footprintMb? }` and its memory is the larger of the
   values measured IN THAT PROBE. A footprint is never reused by a later reading.
5. **Unmeasurable** is explicit: if the session is alive and any step fails, times out, or no
   server matches, the reading is `unknown`. `unknown` never kills. After 6 consecutive `unknown`
   probes with a live session, one `[Supervisor] memory ceiling cannot read the server's memory: <step>`
   line is logged, `/lifeline status` shows "memory ceiling: cannot read (<step>)", and probing
   backs off to every 60 s until a reading succeeds. A probe still running at the next tick is
   left to its deadline; no second probe starts.

Nothing in the log line, the record or the notice contains a command line: only pid, memory,
ceiling, uptime and machine name.

### 2. Ceiling

`lifeline.serverMemoryCeilingMb` in `.instar/config.json`, resolved by `TelegramLifeline` at
start and passed to the supervisor as a constructor option (the supervisor reads no config itself):

- absent, or not a finite non-negative number → default `min(8192, 50% of os.totalmem())`; an
  invalid value also logs one line.
- `0` → disabled; logged once at lifeline start ("memory ceiling is off by configuration").
- every value, the default included, is clamped to `[3072, 90% of os.totalmem()]` MB; if 90% of
  RAM is below 3072 MB the ceiling is disabled with one log line saying why.

A change takes effect at the next lifeline start. Tests can lower the 3072 floor through a
constructor option; no configuration path reaches it.

### 3. Action: kill now, respawn by the normal rules

A breach is confirmed by EITHER a second fresh reading at or above the ceiling for the same pid and
session id at any time after the first (no maximum gap: under starvation ticks have been recorded
300-980 s apart, and a time window would never confirm then), OR a single reading at or above 1.5x
the ceiling. A different pid or session id clears the first one, and so does a reading below the ceiling on
every measure the first one used (a breach seen in the footprint is cleared only by a footprint
below the ceiling, never by RSS alone). Then:

1. Latch `memoryKillInFlight` (a second breach while it is set does nothing) and clear the reading.
2. Re-probe (same deadline, footprint included on macOS); continue only if the same pid is still the
   server in the same session id AND the fresh reading is still at or above the ceiling. A recovered
   reading cancels the kill and releases the latch; a normal restart that replaced the session
   meanwhile has a new session id and is left alone.
3. Cancel any restart timer the unhealthy path has pending. Today each `handleUnhealthy()` call creates a new
   anonymous backoff `setTimeout`, so several can be pending while the session stays missing; their
   handles are kept in a set and all cleared here. In addition each health probe captures the supervisor's `spawnGeneration` when it STARTS and
   carries it through `evaluateUnhealthyServer()` / `handleUnhealthy()` into any delayed restart;
   if a spawn or a memory kill has advanced the generation, the stale result changes no counter,
   emits nothing and tears nothing down. So a health check that began on the old server and
   resolves after the replacement started can never act on the replacement. Then
   `SIGKILL` the server pid and the pane's process group (tmux `setsid()`s the pane child, so
   pgid == pane pid; node, the `tee` subshell and non-detached children such as cloudflared share
   it, and the group kill reaches them even after they are reparented). The group is signalled
   only after checking that its id equals the pane pid read in this probe for this session id.
   Children the server started with `detached: true` are in their own group or session and are
   deliberately NOT signalled: some are built to outlive the server (the remote-desktop relock
   guard in `MacDesktopHost`, detached git writes that would leave `.git/index.lock`, Local Verify
   runs), exactly as a normal crash leaves them today.
   Then `kill-session -t <session id>` (the id, not the name, so a replacement session is never hit;
   bounded at 5 s). The existing name-based helpers `captureCrashOutput()` and
   `cleanupChildProcesses()` are NOT used here: once node dies the pane closes and a lookup by name
   finds nothing or the wrong session; the server's stderr log already holds its last output. SIGKILL
   because a thread spinning in native code would not run a SIGTERM handler. No backoff. This step
   runs regardless of the circuit breaker, the cooldown, a planned restart or maintenance wait:
   those gate respawning, never the kill.
3b. Confirm the stop: the server pid must be gone (`kill(pid, 0)` fails) within 2 s; if not, one
   more SIGKILL and another 2 s. A server still alive after that is recorded with
   `stop: 'failed'`, logged loudly, the latch released so the next reading tries again, and
   nothing below (count, hold, `isRunning`) changes. Only a confirmed stop is counted.
4. Record `{ id, at, pid, memoryMb, ceilingMb, uptimeSec, machine, sample: 'pending' | 'skipped' }`
   as one JSON line at once, and a second line `{ id, sample: 'finished' | 'timed-out' | 'failed' }`
   when the sampler ends (a sample counts as finished only if its file exists and is non-empty), in
   `.instar/logs/server-memory-ceiling.jsonl`. When the file passes 1 MB it is rewritten from its
   last 256 KB (tail read, never a whole-file read), starting at the first complete line.
5. Set `isRunning = false` itself, and drop any queued restart (step 3). The only `serverDown` emit (in `handleUnhealthy()`) fires only
   while `isRunning` is true, so when the next tick finds the session gone no "server went down"
   notice is sent for this stop; the emit site is unchanged. Respawn then follows the existing rules
   plus the memory hold below: at
   once on the planned-restart paths, after the 5-80 s backoff normally, up to 5 minutes in the
   cooldown, and at the breaker's retry slots (30/60/90 min, then every 2 h) when the breaker is
   open; the existing breaker and still-down notices cover those last two. The memory path emits
   `memoryCeilingKill` with the record.
6. Clear the latch when the next reading is of a different pid, or after 60 s.

Memory respawn hold: it activates on the same rule as the notice (the third kill within a rolling
6 hours) and, once active, escalates by the episode count, so the hold and the notice always start
together (kills at 0, 5 and 10 h are one episode but never three in 6 h: no hold, no notice).
AUTOMATIC respawn then waits until
`holdUntil` = kill time + 5 min, doubling per further kill in the episode (10, 20) and capped at
30 min. The hold is one early return at the top of `handleUnhealthy()`: while it is active and the
server session is gone, the call returns before any failure counting or timer, so a hold never
advances `restartAttempts`, `totalFailures` or the circuit breaker. The health interval keeps
running (nothing calls `stop()`), so probing continues and the first tick after `holdUntil` takes
the normal path. Every other way a server is started ignores the hold, on purpose: lifeline boot
(`start()`, including after an update while a hold is saved), `/lifeline restart` and
`/lifeline reset` (operator actions), the doctor's debug restart, planned and update restarts
(`performGracefulRestart()`), and a wake request. The planned-restart and legacy-flag respawn
branches INSIDE `handleUnhealthy()` (driven by the updater's exit marker) sit below the early
return and are held like any automatic respawn; the server is already dead then, so holding them
only delays the start. The hold is kept in the state file, shown in
`/lifeline status`, and cleared when the episode ends. Once the 30-minute cap is reached this
bounds automatic restarts of a server that balloons on every boot to ~2 per hour, while kills stay
immediate.

Evidence: on macOS, the first over-ceiling reading starts `/usr/bin/sample <pid> 3 -file
.instar/logs/server-memory-sample-<ts>.txt` in the background (killed at 6 s if still running);
the kill never waits for it. At most one per hour; only the newest 5 sample files are kept. Its
outcome (`finished` / `timed-out` / `skipped`) goes in the record.

### 4. Convergence

- Steady-state bound: a kill needs a server above the ceiling and a fresh server starts at
  ~0.2-0.8 GB, so there is at most one kill per server lifetime; after three kills in 6 hours the
  memory hold spaces respawns 5, 10, 20, then 30 min apart, so once the ladder reaches its cap
  restarts are bounded at ~2 per hour even when a healthy tick between balloons resets the existing
  breaker. The memory path never spawns anything.
- Brake: `.instar/state/server-memory-ceiling.json` keeps `{ kills: [timestamps in the last 6 h],
  lastKillAt, episodeKillCount, episodeNotified, holdLevel, holdUntil }` (it survives lifeline restarts, which happen after every
  update). An episode lasts while kills are less than 6 h apart; `episodeNotified` resets only when
  `lastKillAt` is more than 6 h old, so kills at 0, 1, 2, 7.5 and 7.75 h are one episode with one
  notice and holds of 5, 10 and 20 min after the third, fourth and fifth, and a lifeline restart
  between kills keeps that state (the hold level comes from `episodeKillCount`, not from the 6 h
  window).
  Kills continue without limit because each one prevents machine-wide harm; the agent restarts at
  the ladder's pace, so it is reachable between balloons except while the cooldown or an open
  breaker holds respawn (both already notify).
- Ratchet: the controller carries an `@self-action-controller:` marker and a
  `SELF_ACTION_CONTROLLERS` entry in `src/testing/selfActionRegistry.ts` with the same fields as the
  other entries (`restartPosture`, `makeUnderPressure`, ...), checked by
  `scripts/lint-no-unregistered-self-action.js` and `tests/unit/self-action-convergence.test.ts`.

### 5. Notice

A single self-healed kill sends nothing (Near-Silent Notifications, Self-Heal Before Notify): it is
in the log, the JSONL record, and `/lifeline status`, which gains one line ("memory ceiling: 8 GB,
last stop 14:02, 1 in the last 6 h").

When the third kill lands inside 6 hours, the lifeline sends ONE plain notice for the episode on
the lifeline topic. That topic is the lifeline's create-once system topic for its own health (the
circuit breaker and still-down notices go there); no topic is created per notice, which is what
the alerts-topic standard forbids. Each sentence is built from recorded state, never assumed:

> My server on Justins-Laptop keeps using too much memory: it went past its 8 GB limit 3 times in
> the last 6 hours (last time 18.1 GB), and each time I stopped it.
> [answered /health after the kill, i.e. `lastHealthy` later than the kill:] It is running again now.
> [hold active:] I will wait 5 minutes before starting it again, so it does not keep filling the machine.
> [otherwise:] It has not come back yet; I will keep trying and tell you if it stays down.
> [a finished sample file exists:] I saved a record of what it was doing when it happened.

The episode ends after 6 hours without a kill; a later episode can notify again. This is per
machine by design (each lifeline watches its own server), so the text names the machine. No
one-voice gating applies to lifeline notices today, and none is claimed.

### What it does not do

It watches only the agent's own server process. It does not restart a server for being slow or
busy. It does not replace the HTTP/1.1 pin.

## Foundation audit

Simplest robust route: an operating-system limit is not available. macOS and current Linux kernels
do not enforce `RLIMIT_RSS`; `RLIMIT_AS` breaks V8, which reserves large address ranges; V8 heap
flags (`--max-old-space-size`) do not bound native memory, where this balloon lived (nghttp2 frame
buffers); a cgroup memory limit exists only on Linux and needs a delegated or writable memory cgroup, which
an agent installed per user usually lacks. An external measurement from the
supervisor is the one route that works on every supported platform.

The existing restart path is not safe for this use: every branch of `handleUnhealthy()` that
returns early or delays (breaker open, cooldown, planned restart, legacy flag, backoff timer)
would leave a runaway running, and its name-based teardown helpers miss a session whose pane has
already closed. The memory path therefore has its own kill by pid and session id, and changes
none of those branches. Its one addition to the respawn side is the memory hold guard.

## Multi-machine posture

machine-local-justification: hardware-bound-resource

Machine-local by design: the resource is the physical memory of the machine the server runs on,
and each machine's lifeline watches its own server process. The state file and the record are
per machine for the same reason. The notice names the machine.

## Frontloaded Decisions

- Default ceiling min(8192 MB, 50% RAM), every value clamped to [3072 MB, 90% RAM], disabled below
  ~3.4 GB RAM and by `0` (both logged).
- Confirmation: a second fresh reading (any gap) or one reading at 1.5x.
- Kill immediately (process group, then session id), independent of breaker/cooldown/maintenance;
  a recovered recheck cancels; respawn by existing rules plus the memory hold (5-30 min from the
  third kill in an episode), which gates only the automatic respawn in `handleUnhealthy()` and is
  overridden by boot, operator restart/reset, doctor, planned/update restarts and wake; no
  `serverDown` notice for a memory stop.
- No notice for a single kill; one notice per episode at 3 kills in 6 h, lifeline topic, sentences
  from recorded state.
- Footprint on macOS every 30 s; sample at most once per hour, newest 5 kept.
- Ships on by default, a deliberate divergence from the test-agent → dev-agent → fleet ladder: it
  is a physical safety limit with 4x headroom over measured use at the 8 GB default (1.5x on a
  4 GB machine, where the ceiling clamps to 3 GB), the failure it prevents takes the
  whole machine down, and every fleet agent on Node 26 is exposed today; `0` is the rollback.

## Open questions

*(none)*

## Migration

None. The default lives in code and reaches existing agents on update. The ceiling is an
intervention threshold checked on each supervisor tick, not a hard allocation limit: memory can
grow between readings (ticks have been seen minutes apart under starvation, which the 1.5x rule
shortens but cannot remove). The Laptop's local `server-rss-watchdog.sh` (not part of instar,
same polling nature, 60 s interval) can be retired after this ships.

## Testing

- Unit (`tests/unit/server-memory-ceiling.test.ts`): ceiling resolution (absent, invalid, 0,
  clamps, the default on 4 GB and 3 GB machines); server identification from a realistic tree
  (pane shell, tee, other agents' servers, exec'd launcher, adopted server); one reading does
  nothing; a second fresh reading for the same pid and session kills once, even 10 minutes later;
  one reading at 1.5x kills; a lower reading on the same measures, a pid change or a session-id
  change resets; one high footprint cannot count twice; a footprint breach is not cleared by a
  low-RSS probe and is confirmed by the next footprint; a recovered recheck cancels the kill; a server that survives the SIGKILL is
  recorded as a failed stop and not counted; a health result that started on an older spawn
  generation changes nothing; detached children (a relock-guard stand-in, a detached git child)
  survive the kill; a tree with more than 1 MB of unrelated arguments still yields the server's
  reading; kills at 0/5/10 h start neither hold nor notice;
  node's non-detached children are killed with it through the process group, including a child that ignores
  SIGHUP and outlives node; a restart timer pending from before the kill is cancelled and never
  tears down the replacement; the episode state survives a reload and notifies once for kills at
  0, 1, 2, 7.5, 7.75 h; the memory hold delays the automatic respawn from the third kill without
  advancing the restart or breaker counters, ticks keep probing during it, `/lifeline restart`
  and a lifeline boot during a hold start the server, and it clears when the episode ends; a session replaced between confirmation and kill survives; the
  probe deadline yields `unknown`; `unknown` never kills and degrades after 6; the kill happens
  with the breaker open, during cooldown, and during a planned restart; no second kill while the
  latch is set; a real `runHealthTick` after the kill does not emit `serverDown`; the 3-in-6 h
  count survives a reload from the state file; footprint suffix parsing.
- Integration (`tests/integration/server-memory-ceiling-notice.test.ts`): the lifeline sends no
  notice for one or two kills, one notice at the third, none for a fourth in the same episode; the
  notice's recovery and sample sentences follow the recorded state (respawn held, sample timed
  out); no "server went down" notice for a memory kill; `/lifeline status` shows the line.
- E2E (`tests/e2e/server-memory-ceiling-live.test.ts`): a real tmux session running a node process
  with `cli.js server start --foreground` in its arguments allocates past a 256 MB ceiling (test
  floor) and starts a child that ignores SIGHUP; the real probe finds the server, the real kill ends
  both processes, the session is gone, a second session started afterwards under the same name
  survives, and the record is written.

## Rollback

Set `lifeline.serverMemoryCeilingMb: 0` and restart the lifeline, or revert. The state file and
record are inert without the code.
