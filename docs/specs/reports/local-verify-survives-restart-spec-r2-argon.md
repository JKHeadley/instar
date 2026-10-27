# spec review round 2 — Gemini 4 Argon (gemini CLI), 2026-10-26

### 1. Verdict
**Ready.**

All Round 1 findings (from both Astra and Argon) have been cleanly resolved in the spec and implementation:
- **Process groups, launchd, locks & ports:** Sound. The server runs inside the detached `tmux` server daemon (separate process group from the lifeline's launchd job). `quiesceEverything()` synchronously stops timers, unregisters the PID-guarded lifeline agent entry, releases the lifeline lockfile, and calls `supervisor.detach()` *before* the first `await`.
- **Fencing & competing stop requests:** `detached` fences every supervisor path (`runHealthTick`, in-flight `checkHealth` probes, `checkSleepRequest`, `checkRestartRequest`, `evaluateUnhealthyServer`, `handleUnhealthy` and its restart timer, `performGracefulRestart`, `spawnServer`, and `stop`). If a `watchdog` or external stop signal arrives while a `keepServer` restart is quiescing or persisting, `stopServerOverride` runs `supervisor.stop({ evenIfDetached: true })` before exit.
- **Busy-server adoption:** `ServerSupervisor.start()` checks `sessionAlive && (responding || this.isServerSessionAlive())`. A dying session that vanishes during the probes falls through to `spawnServer()`; a live session whose event loop is busy under a 23-minute verify is adopted with `spawnedAt = Date.now()` and handed to the health loop's process-alive tolerances rather than killed on arrival.
- **Interruption accounting & starvation:** `shutdown()` and unclean boot restoration (`inFlight: true`) both count the attempt, increment `interruptions`, and set `resumeFirst`. Restored entries and terminal unclean-exit drops both run `raiseStarvedIfDue()` at boot, `checkStarved()` includes `this.inFlight`, and `starvedRaised` is persisted immediately and carried across head pushes alongside `resumeFirst`.

---

### 2. Factual errors against the code
None. Every file path, method signature, bucket policy, and test description in `docs/specs/local-verify-survives-restart.md` and `docs/specs/local-verify-survives-restart.eli16.md` matches the current branch diff.

---

### 3. Safety problems
None.

---

### 4. Gaps against the incident
None. All four root causes from the 2026-10-26 incident (drift self-restart killing the server, post-restart `main-suspect` priority pushing the interrupted PR behind `main`, `shutdown()` un-counting attempts, and `onStarved` not wired to attention items) are addressed and covered by unit, integration, and e2e tests.

---

### 5. Over-engineering to cut
None. The solution is minimal, proportional (80/20), and easily reversible.
