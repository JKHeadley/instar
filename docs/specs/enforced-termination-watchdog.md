# Enforced Termination Watchdog — an external hard-stop for autonomous runs

**Status:** draft (spec). Tag: pending review-convergence.
**Constitution:** *The User Experience Is the Product* → sub-standard #2 **Enforced Termination**; an instance of *Structure beats Willpower* applied to the **end** of work; sibling of *An Autonomous Run Must Outlive Its Session* (which keeps a run alive across vessel events — this is its deliberate counterweight: keep a run from outliving its **budget**).
**Earned from:** 2026-06-25 — an autonomous run (topic 27515) with a hard 24h budget ran ~46h (iteration 216), continuously churning the machine pool and spawning subprocesses. Nothing outside the run forced it to stop. Full context: `docs/incidents/2026-06-25-user-reachability-postmortem.md` (Failure 2).

---

## 1. The problem — enforcement lives inside the run

Today an autonomous run's deadline is enforced in exactly one place: the per-session **Stop hook** (`.claude/skills/autonomous/hooks/autonomous-stop-hook.sh:472-489`), which checks `elapsed >= duration_seconds` at a Claude Code **Stop event** (a turn boundary) and removes the state file. That is *the run's own willpower* — and it has four holes the runaway fell through:

1. **No Stop event ever fires.** A wedged or tight-looping session that never cleanly reaches a turn boundary never runs the check. (This is how 27515 ran 46h.)
2. **Unbounded runs.** `duration_seconds` absent/0 ⇒ the hook's `[[ $DURATION_SECONDS -gt 0 ]]` guard skips, and `autonomousRunRemainingForTopic()` (`src/core/AutonomousSessions.ts:106-126`) returns `null` — the run has no deadline at all and is invisible to every "how long is left" path.
3. **Unparseable `started_at`.** The hook fails *toward keep-running* (`autonomous-stop-hook.sh:486-488`).
4. **No external clock.** Nothing outside the run's process holds the budget. There is no duration-based killer anywhere in `src/monitoring/` (confirmed). `SessionClockReader`/`SessionClock` only *compute and display* `remainingSeconds` — they never gate.

Every structural pressure in Instar points toward **continuing** (the stop-gate, "No context-death self-stops", the completion-discipline that refuses premature exit). **None points toward terminating on time.** The discipline meant to prevent laziness instead sheltered a runaway. This spec adds the missing opposite force, as *structure outside the run*, never the run's own discretion.

## 2. Design — `EnforcedTerminationWatchdog`

A level-triggered monitoring loop (mirrors `AutonomousLivenessReconciler`) that, each tick, finds runs that have **provably overrun** and drives them to a **durable** terminated state. It is the external twin of the in-hook duration check — it does **not** reimplement the math, it reuses `autonomousRunRemainingForTopic()` and the raw frontmatter.

### 2.1 Overrun predicate (per active run)

A run is `overrun` when **any** of:
- **Time budget exceeded:** `duration_seconds > 0` AND `now - started_at >= duration_seconds + graceSeconds`. (`graceSeconds` default 120s — lets the cooperative hook win the normal case; the watchdog only fires when the hook *didn't*.)
- **Absolute ceiling (covers the unbounded + unparseable holes):** `now - started_at >= absoluteCeilingSeconds` (default 26h — just past the longest sanctioned run; a hard backstop that fires even when `duration_seconds` is null/0 or `started_at` is malformed-but-old). An unparseable `started_at` is treated as *file mtime* for this ceiling only (fail toward a bounded stop, never toward run-forever — the inverse of the hook's bias, because here the safe direction is termination).
- **Iteration ceiling (optional):** `iteration >= maxIterations` when configured.

`overrun` is computed from durable state only (the frontmatter + file mtime), so it survives a server restart.

### 2.2 Two-phase confirm (no kill on a single read)

Mirrors `SessionReaper`'s reap-pending pattern. Tick N marks a topic `terminate-pending` (persisted in durable cap state); a kill happens only when tick N+1 **re-confirms** the same topic is still overrun AND still has a live session. This absorbs a clock blip, an in-flight cooperative stop landing between ticks, and a just-completed run.

### 2.3 The durable termination (the reconciler-coordination crux)

A deliberately-terminated run must **stay** terminated against the **two** respawn paths — the `AutonomousLivenessReconciler` and the `ResumeQueueDrainer`. From the existing operator-stop coordination, a durable stop requires **all** of:

1. `stopAutonomousTopic(stateDir, topic, journal)` — emits the `stopped` journal row and **deletes the state file** (`AutonomousSessions.ts:357-365`). Once gone, `listActiveRuns()` yields nothing → not a reconciler candidate. **Load-bearing across restarts.**
2. `operatorStopRecorder(topic)` (the watchdog is an authorized internal stopper) — records the stop timestamp the reconciler rechecks at criteria-3, at actuation, and post-spawn (`AutonomousLivenessReconciler.ts:373,625,666`). Belt for the window where the file might be re-synced from a peer.
3. `resumeQueue.cancelByTopic(topic)` — the ResumeQueue is a second respawn path that also honors `operatorStopSince` (`ResumeQueueDrainer.ts:566`).
4. Clear mid-work, then hard-kill the live session: `sess.endedMidWork = false; state.saveSession(sess)` **then** `sessionManager.killSession(...)` — mirrors `settleKill` (`server.ts:8005-8016`) so the kill is not itself queued for revival.

The **generation guard** (`AutonomousLivenessReconciler.ts:713-719`) already ensures a genuinely-new run on the same topic (newer `started_at`) is *not* blocked by an old termination — so re-launching the topic later is unaffected.

### 2.4 What it must NOT do

- **Never terminate a run still inside its budget** — even one that looks idle. (That is the reaper's job, under its own pressure rules; this watchdog fires *only* on budget overrun.)
- **Never fight a cooperative stop.** The `graceSeconds` window gives the in-hook check first right of termination; the watchdog is the backstop for when it can't run.
- **Never silently disable itself.** Registered unconditionally in the guard posture (below).

## 3. User-facing surfacing (the standard's "loud" requirement)

Per sub-standard #6 *Degradation Is an Event* and the umbrella rule that a stop is never silent: every enforced termination posts **one** plain-English notice to the run's report topic — *"I stopped the autonomous run on <topic> — it passed its <N>h budget by <M>. Anything unfinished is in its notes; tell me to relaunch if you want me to continue."* — and an Attention item if the report channel is unavailable. This is the inverse of the 27515 silence, where the overrun was visible to no one.

## 4. Rollout & observability (mirror the fleet template)

- **Dev-gate + dryRun-first:** `monitoring.enforcedTermination.enabled` **omitted** from `ConfigDefaults` ⇒ ships dark fleet-wide, resolves live on a development agent via `resolveDevAgentGate`; `dryRun: cfg.dryRun ?? true` ⇒ on dev it computes overruns and logs `would-terminate` + shadow cap counters but actuates nothing until a deliberate `dryRun:false`.
- **Guard posture:** expose `guardStatus()` and `guardRegistry.register('monitoring.enforcedTermination.enabled', …)` **unconditionally** (even when disabled) so a silently-off watchdog reads `off-runtime-divergent` on `/guards`, not invisible.
- **Audit:** append-only `logs/enforced-termination.jsonl` (5MB×1 rotation), one row per transition (`overrun-detected` / `terminate-pending` / `terminated` / `would-terminate` / `false-alarm` / `skipped-grace`), each stamped with topic, started_at, duration_seconds, elapsed, predicate-that-fired.
- **Bounded actuation:** per-window cap on terminations (a flapping detector gives up LOUDLY via one aggregated Attention item rather than kill-looping — P19), durable cap state (`loadCapState`/`saveCapState`).
- **Status route:** `GET /autonomous/enforced-termination` → `{ enabled, dryRun, graceSeconds, absoluteCeilingSeconds, lastTickAt, pending:[topics], terminated24h, wouldTerminate24h }` (503 when dark).

## 5. Tests (all three tiers + wiring + both decision sides)

- **Unit:** overrun predicate — within budget (no), past budget+grace (yes), unbounded run past absolute ceiling (yes), unparseable started_at older than ceiling by mtime (yes), iteration ceiling. Two-phase confirm: single overrun tick does NOT kill; two consecutive do. dryRun: computes + logs `would-terminate`, actuates zero.
- **Durability/wiring:** a terminated topic is gone from `listActiveRuns`; `operatorStopRecorder` called; `resumeQueue.cancelByTopic` called; `endedMidWork` cleared before `killSession`. Integration with a stub reconciler: after termination, the reconciler does NOT respawn (criteria-3 stop recheck honored). A genuinely-new run on the same topic (newer started_at) IS allowed (generation guard).
- **Integration (HTTP):** `/autonomous/enforced-termination` returns 200 with the feature on (dev), 503 when dark.
- **E2E:** with the watchdog live (dryRun:false) on a throwaway agent, a seeded run with a 5s budget + a wedged (no-Stop-event) session is killed within ~2 ticks and stays dead; the report topic gets the plain-English notice.

## 6. Open questions (for review-convergence)

1. **`absoluteCeilingSeconds` default** — 26h assumes the longest sanctioned run is ~24h. Should it instead be `max(observed duration_seconds across runs) + margin`, or a config-derived multiple of the run's own budget (e.g. `1.5 × duration_seconds`, falling back to a flat ceiling only for unbounded runs)? The flat 26h is simplest and covers the incident; the per-run multiple is tighter for short runs.
2. **Grace vs. wedge** — `graceSeconds` (120s) lets the cooperative hook win, but a truly wedged session never fires the hook, so grace just delays the inevitable kill by 2 min. Acceptable, or should a *separately-detected* wedge (no turn boundary in N min past deadline) skip grace entirely?
3. **Unbounded runs** — should the watchdog instead *refuse to let a run start unbounded* (a `can-start` gate that requires a `duration_seconds`), making the absolute ceiling a backstop rather than the primary path? That is arguably the more structural fix (enforce a budget at creation), with this watchdog as defense-in-depth.
4. **Interaction with a topic mid-move** — if a run is suspended for a cross-machine move (`move_suspended_at` set), the watchdog must treat it as not-active (no kill) and let the destination re-evaluate. Confirm the predicate excludes `move_suspended_at`/`moved_to` rows.
