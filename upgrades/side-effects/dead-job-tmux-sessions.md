# Side-Effects Review — finished job sessions no longer leave dead tmux sessions behind

**Version / slug:** `dead-job-tmux-sessions`
**Date:** `2026-09-28`
**Author:** `echo`
**Second-pass reviewer:** `required (session lifecycle: kill path)`

## Summary of the change

Incident (Mac Studio, 2026-09-27/28): the sibling agent groky left one dead
tmux session per finished scheduled job (`groky-job-<slug>-<id>`), about 1,000
a day (987 cleared by hand on 09-27, 940 on 09-28), all on the tmux server
every agent on the host shares.

Cause, confirmed from groky's own records (read only): its session records end
`status: completed, endedReason: process-exited-during-startup`
(`framework: grok-build`), and `logs/server-launchd.err` has 19,500 lines
`Session "job-…" (grok-build) exited on its own after 16s`. Every job spawn
path calls `retainFailedExitStatus()` (`remain-on-exit failed`) so the monitor
can read `pane_dead_status`. The monitor's self-exit branch in `#monitorTick`
reads the status, marks the record completed, emits `sessionExited` /
`sessionComplete`, and `continue`s — it never kills the retained pane. Topic
sessions are reclaimed by their next same-name spawn (`spawnInteractiveSession`
kills a dead same-name session), but job session names are unique per run, so
nothing ever reclaims a job's dead pane.

Fix (`src/core/SessionManager.ts`):

1. In the self-exit branch, after the record and events, if the session has a
   `jobSlug`, `removeDeadJobPane()` re-probes `#{pane_dead}` and runs
   `kill-session` only when it reads `1`.
2. `sweepDeadJobPanes(maxKills = 50)` runs from the existing 5-minute cleanup
   slot in `#monitorTick`. It lists sessions, and kills (via the same
   `removeDeadJobPane`) only those whose name starts with
   `<basename(projectDir)>-job-`, whose pane is dead, which no running record
   owns, and whose tmux session environment contains
   `INSTAR_AGENT_HOME=<this projectDir>` and an `INSTAR_JOB_SLUG=` entry (both
   set by every job spawn path).

All tmux calls go through the existing bounded `tmuxExecAsync` (SIGKILL-capped
timeout). No agent-installed files change, so no migration is needed.

The pre-existing, already-logged catch in `retainFailedExitStatus()` gains a
`@silent-fallback-ok` tag: the new methods sit inside its 20-line scan window
for `tests/unit/no-silent-fallbacks.test.ts` and displaced the marker that used
to exempt it (the documented window artifact; count stays at the 495 baseline).

## Decision-point inventory

- Self-exit branch: new "remove the job's dead pane" action — deterministic
  cleanup of an already-finished resource, guarded by a fresh `pane_dead` probe.
- Backstop sweep: new "is this a dead job pane of mine" predicate — an
  ownership/liveness invariant, not a judgment.

## 1. Over-block

Not a block/allow surface. The over-reach question is "can it kill something it
shouldn't?": a live pane is never killed (fresh `pane_dead` probe right before
the kill); an interactive session is never killed (the self-exit path requires
`jobSlug`; the sweep requires `INSTAR_JOB_SLUG` in the tmux env, which only job
spawns set); another agent's session is never killed (its env names a different
`INSTAR_AGENT_HOME`); protected sessions are skipped. A dead pane still owned by
a running record is left to the monitor branch so its result is recorded first.
One loss: a finished job's dead pane is no longer available for a human to
inspect after the fact. The exit status and the startup-window tail are already
captured into the record / reap-log before the kill, which is what the
retention existed for.

## 2. Under-block

- A job pane that ends in a bare shell (not dead) is still classified by the
  existing bare-shell rule and marked completed; since its pane is not dead it
  is not removed. Job launches run the framework binary directly as the pane
  command, so this shape does not arise from instar's own spawns.
- A dead job pane from before a server restart whose record was already pruned
  is covered by the sweep (ownership comes from the tmux env, not the record).
- Multi-pane/window job sessions: `list-sessions` reports the active pane; job
  sessions are single-pane.

## 3. Level-of-abstraction fit

Right layer: `SessionManager` owns spawn (where the retention is set) and the
monitor transition (where the status is consumed). The kill belongs next to the
consumption. The SessionReaper is for idle LIVE sessions and is disabled on
groky (`sessionReaper.enabled: false`), so it was not the right owner.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It performs cleanup of provably finished resources; the only authority it uses
(kill) is gated by an invariant (`pane_dead == 1` + ownership), not by a
heuristic about intent.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Pane process has
exited and the session belongs to this agent's job" is an enumerable invariant.

## 5. Interactions

- **Shadowing:** the sweep skips any tmux session a running record owns, so it
  never pre-empts the monitor's self-exit branch (which records the exit code
  and fires `sessionExited` / `sessionComplete` before removing the pane).
- **Double-fire:** the monitor branch and the sweep can both target the same
  name only if the record already left `running`; the second `kill-session`
  then gets "can't find session", which `tmuxExecAsync` returns as
  `definitely-absent` — harmless.
- **Races:** listeners of `sessionComplete` (JobScheduler, TopicResumeMap) run
  synchronously before the kill, so any listener that reads the pane does so
  first. Spawn's dead same-name reclaim is for topic names; no overlap.
- **Feedback loops:** none; the sweep only removes, never spawns.

## 6. External surfaces

Other agents on the same machine: their sessions are never touched (ownership
check on the env), and the shared tmux server stops accumulating ~1,000 dead
sessions a day from this agent. No persistent state, no user-facing notices, no
operator-facing actions. One new log line when the sweep removes something.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: tmux sessions are per-machine processes; each
machine's server cleans its own tmux server. No notices, no durable state, no
URLs.

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state. During a
rollback window dead job panes would accumulate again, as before.

## Conclusion

The leak is a missing kill after the monitor consumes a retained failed pane;
the fix adds that kill for job sessions plus a bounded, ownership-checked
backstop sweep. Separately worth reporting to groky's operator: its Grok jobs
exit non-zero ~16s after start on every run; this change removes the leftovers,
not that failure.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (read-only)
**Independent read of the artifact: concur**

Concur: nothing can kill a live pane, an interactive or topic session, a
protected session, or another agent's session; `JobScheduler.notifyJobComplete`
reads the pane synchronously inside the emit, before the kill; `INSTAR_JOB_SLUG`
is set on both job spawn paths (headless and rerouted-interactive) for every
framework. Minor, non-blocking note: `maxKills` bounds kills, not probes — with
a large backlog the first sweep runs one `show-environment` per matching dead
session; accepted, as each is a single bounded tmux call and only
prefix-matching dead panes are probed.

## Evidence pointers

- `tests/unit/dead-job-pane-cleanup.test.ts` (real tmux, private `-L` socket):
  job exit → removed; interactive dead pane kept; live job kept; sweep removes
  only this agent's dead unowned job panes and respects its cap. The first test
  fails with the self-exit kill removed (verified by reverting the call).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. The sweep is a self-triggered cleanup that
only removes already-dead resources: it never spawns, restarts, notifies or
retries, and is bounded (50 kills per 5-minute pass), so it cannot oscillate.
