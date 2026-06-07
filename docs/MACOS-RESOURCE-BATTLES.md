# macOS Resource Battles — a living battle log

> **Why this doc exists.** macOS background daemons repeatedly contend with the instar
> fleet for CPU and I/O on the dev machine, producing recurring "the box is overloaded /
> the server is temporarily down" incidents. This kept being re-diagnosed from scratch and
> living only in tribal memory. This is the durable, version-controlled record of every
> macOS-vs-instar battle: the symptom, the real root cause, what we tried, what actually
> worked, and what is still open. **Append to it every time macOS sabotages us again.**
>
> Maintained by: Echo (instar dev agent). Started 2026-06-07 at Justin's direction
> ("I'm tired of macOS sabotaging our work. We need to thoroughly document and track our
> battles with this, because it keeps coming up… we should NOT assume [turning off iCloud
> Photos] will fix our macOS struggles").

---

## The core insight (read this first)

**There is no single "macOS fix." The war is fought on two fronts, and both are permanent:**

1. **Front A — shrink macOS's own footprint where we're allowed to.** Exclude our churning
   directories from Spotlight, stop Photos analysis, etc. These are *point* fixes against
   *specific* daemons. Each one kills one antagonist; none of them ends the war. Many of the
   worst offenders are **SIP-protected** and cannot be disabled at all without the operator
   disabling System Integrity Protection in recovery mode.

2. **Front B — make instar resilient to host load it cannot control.** The dev machine is a
   shared host. macOS *will* spike CPU on its own schedule (Spotlight reindex after an OS
   update, Time Machine, iCloud sync, Photos analysis after an import). instar must treat a
   noisy host as the normal condition, not an emergency: never mistake host-induced
   event-loop lag for a real problem, shed its own load under pressure, reap idle work, and
   survive restarts cleanly. **This front is the one fully in our control, and it is where
   the durable wins are.**

> **Corollary (Justin, 2026-06-07):** do not declare victory when one antagonist goes quiet.
> Turning off iCloud Photos removes `mediaanalysisd`; it does nothing about Spotlight, Time
> Machine, or the next OS-triggered reindex. Measure the *host*, not one process.

---

## macOS antagonist reference table

The background daemons that have actually shown up as top CPU/I/O consumers on this box.
"Our lever" = what we can do about it without operator/SIP intervention.

| Daemon | What it does | Why it hurts us | SIP-protected? | Our lever |
|---|---|---|---|---|
| `mds` / `mds_stores` / `mdworker_shared` | Spotlight metadata indexing | Re-indexes large, fast-churning dirs (our JSONL transcripts, worktrees) continuously; has hit 50–60% CPU | Yes (daemon); but **content is excludable** | `.metadata_never_index` markers + `mdutil` exclusion on our dirs (shipped) |
| `mediaanalysisd` + `mediaanalysisd-access.xpc` | ML analysis of the Photos library (faces/scenes/objects) | Sustained 50–86% CPU while analyzing/importing a large or iCloud-syncing library | **Yes** — cannot `bootout`/`disable` (returns *"Operation not permitted while System Integrity Protection is engaged"*) | Operator only: turn off iCloud Photos / remove the library; or disable SIP |
| `photoanalysisd` | Photos.app's analyzer that *drives* `mediaanalysisd` | Spikes during Photos analysis; idles when done | Yes | Same as above (driven by the Photos library's existence) |
| `cloudphotod` / `bird` / `cloudd` | iCloud Photos + iCloud Drive sync | Pulls library/files down → triggers Spotlight + media analysis; network + I/O + CPU | Yes | Operator: turn off the relevant iCloud sync on this Mac |
| `backupd` (Time Machine) | Scheduled backups | Periodic I/O + CPU storms; can coincide with our load | Yes | Operator: throttle/disable TM, or exclude large dirs from TM |
| `spotlightknowledged` / `managedcorespotlightd` | Spotlight "knowledge"/suggestions | Minor, but part of the Spotlight family churn | Yes | Covered by Spotlight exclusions |

**How to read SIP-protected:** if `launchctl bootout`/`disable` returns errno 150
("Operation not permitted while System Integrity Protection is engaged"), the daemon is
untouchable from userspace. The only levers are (a) remove its *input* (e.g. the Photos
library, the indexable content) or (b) the operator disables SIP via a recovery-mode reboot
(heavy, generally not worth it).

---

## Battle log (chronological — newest first)

### 2026-06-07 — "server temporarily down on every message" + restart loop
- **Symptom:** every inbound Telegram message returned "server temporarily down"; the server
  failed `/health` (HTTP 000); ~65 boots/day restart loop.
- **Root cause:** **CPU starvation, not an instar bug.** Load climbed to 19–28 on 16 cores,
  driven by `mds_stores` (Spotlight, ~59%) + `mediaanalysisd` (Photos, ~52%+22%). With the
  event loop starved, `/health` couldn't answer inside the timeout → the supervisor marked the
  server unhealthy → the lifeline emitted "temporarily down" (messages queue, not lost). The
  restart loop was amplified by already-delivered messages stuck in the replay queue + blocking
  startup scans.
- **What we shipped (Front B — resilience):**
  - **Reaper "actually reaps" chain** — the SessionReaper existed but reaped 0 sessions. Fixed
    through five sequential root causes: `#955` (ReapGuard stale-commitment override), `#958`
    (reap stale-idle-with-active-children + stale-commitment window 24h→8h per Justin's "8h not
    24h"), `#961` (reaper reads the right transcript dir; StaleSessionBackstop), `#969`
    (`liveActivity` signal so scrollback tool-names don't read as "busy"), `#975` (**durable
    candidacy — the idle clock survives restarts**, so a box restarting every ~10 min no longer
    resets the 45-min clock to zero and reaps nothing).
  - **`#976` SleepWake drift-burst suppression** — the detector mistook event-loop lag for the
    machine sleeping whenever the 1-min load average momentarily dipped below the starvation
    threshold, firing a tunnel-restart storm every 1–3 min. Now: one isolated drift = real
    sleep (emit); back-to-back drifts = CPU choking (suppress, load-independent). This is the
    direct antidote to "macOS load → false wake → restart → more load."
- **Front A:** confirmed the Spotlight exclusions are live and working (our churn dirs are
  excluded); confirmed `mediaanalysisd` is SIP-protected and cannot be disabled from userspace.
- **Operator action:** Justin turning off iCloud Photos (removes `mediaanalysisd`).
- **Status:** A+B shipped + deploying. **Open:** transcript pile-up (below); the host will still
  spike on macOS's schedule — that's why Front B matters.

### 2026-06-06 — resource-overload root: reapers disabled fleet-wide
- **Symptom:** dozens of 26h+ sessions × heavy MCP stacks (72 MCP procs / 175 node / 36 GB RSS)
  accumulating → sustained load 21–30.
- **Root cause:** `sessionReaper` AND `mcpProcessReaper` ship **opt-in and were never enabled**
  on any fleet agent, so idle sessions and unused MCP processes never got reclaimed. Compounded
  by Photos (`mediaanalysisd`) — proven via `lsof` that the media analysis was Justin's Photos
  library, not instar.
- **Action:** enable the existing reapers (canary echo → fleet) + the reaper-actually-reaps chain
  above. Built the **GuardPostureTripwire** so a guard silently disabled (e.g. by an emergency
  load-shed config edit) is itself flagged as an incident at next boot.
- **Status:** reapers armed on echo; fleet rollout pending. **Lesson:** a feature that ships
  disabled and is never enabled is a feature you don't have.

### 2026-06-06 — Spotlight indexing the transcript churn
- **Symptom:** `mds_stores` burning CPU continuously.
- **Root cause:** `~/.claude/projects` (Claude Code JSONL transcripts) is large (now ~18 GB,
  ~151k files) and rewritten constantly as sessions stream → Spotlight re-indexes it forever.
  `~/.instar/agents/*` (per-agent worktrees, 83 GB across 218 worktrees at peak) added more.
- **Action:** `#903` excludes `~/.claude/projects`; `#952` excludes `~/.instar` agent data
  (`ensureAgentDataSpotlightExclusion` + a PostUpdateMigrator so existing agents get it). The
  AgentWorktreeReaper reclaimed 64 stale worktrees.
- **Status:** Spotlight exclusions live + verified (`.metadata_never_index` present on
  `~/.claude/projects`, `~/.instar`, `~/.instar/agents`). **Open:** transcript *retention* —
  exclusion stops indexing but the 18 GB still grows; we still need pruning.

### 2026-06-05 — laptop event-loop stall → live-tail storm
- **Symptom:** echo pinned at high CPU; retry storms.
- **Root cause:** an unbounded live-tail/retry loop spun under load instead of backing off.
- **Action:** `#867` (load-ratio guard + the first SleepWake starvation suppression) +
  ratified the "No Unbounded Loops" standard (P19). echo CPU dropped 33% → 0.7%.
- **Status:** fixed. This is the ancestor of `#976` — `#867` added the load-*ratio* guard;
  `#976` closed the gap where a fluctuating load average let bursts slip through.

---

## instar resilience mechanisms (Front B inventory)

What we've already built so instar survives a noisy host. Keep this list current — it's the
answer to "what protects us when macOS spikes?"

- **SleepWakeDetector starvation guards** — load-ratio suppression (`#867`) + consecutive-drift
  burst suppression (`#976`). Host lag is not treated as sleep → no false wake/restart storm.
- **SessionReaper, CPU-aware** — pressure tier is the worse of memory and CPU
  (`loadPerCore`), so a CPU-bound box raises pressure even when RAM is fine; reaps idle sessions
  (8h-silent + idle prompt + no output, confirmed 3×) with **durable candidacy** that survives
  restarts (`#975`). Decision audit at `logs/reaper-audit.jsonl`.
- **QuotaTracker load-shedding** — sheds background work under pressure.
- **GuardPostureTripwire** — a guard going enabled→disabled (e.g. an emergency load-shed edit)
  is flagged HIGH at next boot, so we never silently run unprotected (`logs/guard-posture.jsonl`).
- **Restart-cascade dampener** — coalesces multiple updates/restarts inside a window into one,
  so an update flurry doesn't become a restart storm.
- **AgentWorktreeReaper** — reclaims merged/clean/unused worktrees (disk + less Spotlight churn).
- **Spotlight exclusion on agent data + transcripts** — `#903`, `#952`.

---

## Open watchlist (unsolved / partial)

- [ ] **Transcript retention.** `~/.claude/projects` is ~18 GB / ~151k files and growing.
      Spotlight no longer indexes it, but the disk + open-file count still climbs. Need a
      retention/pruning policy (age-out old session JSONL). **Not yet built.**
- [ ] **Host-load observability surfaced to the operator.** We read load reactively. A standing
      "macOS is spiking (which daemon)" signal — distinct from instar's own usage — would let us
      attribute incidents instantly instead of re-running `ps` each time.
- [ ] **Time Machine / `backupd` storms.** Seen as a periodic antagonist class; not yet measured
      or mitigated on this box.
- [ ] **Reaper fleet rollout.** Armed on echo (canary); each other agent still needs
      `staleCommitmentWindowMinutes: 480` + `dryRun: false` explicitly.
- [ ] **Post-OS-update Spotlight reindex.** A full reindex after a macOS update transiently
      re-touches everything (even excluded dirs get re-evaluated). Expect a load spike after
      every OS update; Front B must absorb it.

---

## Diagnostic playbook (run this when "the box is overloaded" again)

```bash
# 1. Is it actually starved, and by how much? (load vs cores)
uptime; sysctl -n hw.ncpu

# 2. WHO is burning CPU — macOS or instar? (this is the fork in the road)
ps -Ao pid,pcpu,pmem,rss,comm -r | head -16

# 3. macOS antagonists specifically
ps -Ao pcpu,comm -r | grep -iE 'mds|mdworker|mediaanalysis|photoanalysis|backupd|cloudd|bird'

# 4. instar footprint (process count + total RSS)
ps -Ao rss,comm | grep -iE 'node|claude|instar|tmux' | awk '{s+=$1;n++} END{printf "procs=%d RSS=%.1fGB\n",n,s/1048576}'

# 5. Are our churn dirs Spotlight-excluded?
for d in ~/.claude/projects ~/.instar ~/.instar/agents; do
  [ -f "$d/.metadata_never_index" ] && echo "EXCLUDED: $d" || echo "NOT excluded: $d"; done

# 6. Is a macOS daemon SIP-protected? (errno 150 = untouchable)
launchctl print gui/$(id -u)/com.apple.<daemon> 2>&1 | grep -iE 'state|domain'

# 7. instar's own view — reaper pressure + recent reap decisions
curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/sessions/reaper | head
curl -s -H "Authorization: Bearer $AUTH" "http://localhost:4042/sessions/reaper/audit?limit=20"
```

**Decision rule:** step 2/3 tells you the front. If macOS daemons dominate → Front A (operator
levers, since most are SIP-protected) + make sure Front B is absorbing it. If instar dominates →
reaper/quota/worktree levers (Front B). **Never assume; measure the host every time.**
