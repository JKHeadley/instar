# Side-Effects Review — Stop restarting healthy servers, and stop a closed pipe crashing one

**Version / slug:** `epipe-crash-false-gone`
**Date:** `2026-11-06`
**Author:** `echo (builder echo-echo-epipe-crash)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 19 files, about 400 lines of code and tests plus these notes. Two linked faults took down Studio servers on 2026-11-06.

The supervisor's `isServerSessionAlive` caught every error from `tmux has-session` and returned false, so any failed probe read as a dead server, and the supervisor restarted servers whose logs show they were running. What the probe said at those moments was never recorded, so "got no answer" is an inference (see section 2). Its cleanup SIGTERMs the server and the `tee` behind the server's stderr, and at those moments the server died on an uncaught `write EPIPE`. Now only tmux saying the session is missing counts as gone. Anything else is logged and counts as alive, and the /health checks decide.

A closed pipe also no longer crashes the server: `write EPIPE` joins the non-fatal list, the known unguarded child stdin writers and process stdio get an error listener, and the FATAL line carries the stack. Files: `src/lifeline/ServerSupervisor.ts`, `src/core/pipeErrorGuard.ts` (new), `src/core/uncaughtExceptionPolicy.ts`, `src/commands/server.ts`, and six stdin call sites.

## Decision-point inventory

- `ServerSupervisor.isServerSessionAlive` — modify — a failed probe no longer means dead.
- `uncaughtExceptionPolicy` non-fatal list — modify — adds `write EPIPE`.
- `pipeErrorGuard` — add — absorbs EPIPE only and rethrows every other stream error.

---

## 1. Over-block

The supervisor now restarts less readily. A server that is really dead while tmux also gives no answer waits for the /health path instead of the next 10-second tick:

- About 60 seconds in the normal case (`processAliveThreshold`).
- About 5 minutes on a CPU-starved machine (`starvationRestartThreshold`).
- Up to 10 minutes inside startup grace (`startupGraceMs`), which is where `start()` lands after adopting a session it could not verify.
- Up to 5 minutes during a planned-restart wait (`maintenanceWaitMs`).

All are bounded, and one clean tmux answer ends the wait through the missing-session override. The delay is accepted: the old behaviour killed healthy servers.

---

## 2. Under-block

- tmux wording this code does not know, on exit 1, counts as unknown. The /health path still covers it.
- A server that hangs after its session dies is unchanged.
- This does not fix why probes failed. `spawnSync ... EAGAIN` in the lifeline log points at process-spawn pressure on the host, and that is not measured here. The new warn line records the reason on each failed probe, so the next episode names it.
- Which write raised the two EPIPEs is not proven. The non-fatal path logs the first-seen stack, which may name it: a write that fails at once shows its caller, but a queued write that fails later shows only node internals.
- The EAGAIN lines seen so far come from `spawnServer` and preflight, not from `has-session`, and carry no timestamps. If a false "no server running" caused any of the GONE lines, this fix would not stop it. The gone path now logs tmux's own words, so the next episode shows which it was.

---

## 3. Level-of-abstraction fit

The liveness fix sits in the one probe all callers share, so every caller gets it. The EPIPE handling has three layers on purpose: stream listeners at known writers, the process-level policy as the backstop for unknown writers, and the stack log for diagnosis. `SessionManager` already separates alive, dead and unknown for session checks; this follows that shape in the supervisor with a boolean, because every caller here wants unknown to behave as alive.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over messages or agent actions.

It narrows the authority a brittle signal had: a failed subprocess call could order a restart. The message match decides only whether "gone" is believed; failing to match leaves the decision with the /health checks.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic at a competing-signals point. tmux's own "can't find session" is a direct statement of fact, not a weighed signal.

---

## 5. Interactions

- Fix A in `runHealthTick` (missing session overrides startup grace) still fires for a real missing session; tested both ways.
- `start()` treats an unknown probe as a live session and adopts it, then the health loop decides. If nothing is there, /health failures restart it.
- `spawnServer` kill-session calls after an unknown probe are harmless on a missing session.
- `guardProcessStdio` reports through console, which writes to the same streams. Each stream reports once, so it cannot loop. After the `tee` dies, stderr stops reaching `server-stderr.log` for the rest of that process; `server.log` is unaffected.
- `MacDesktopHost`, `WindowsDesktopLocalTransport`, `codexSpawn` and `memorySandboxProbe` already had stdin handlers and are unchanged.

---

## 6. External surfaces

Users see fewer unexplained restarts. New log lines only: `[Supervisor] tmux session check got no answer` and `[pipe-guard]`. No routes, config, or messages change.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The supervisor watches the server on its own machine, and process crash handling is per process. Nothing replicates and no user-facing notice is added.

---

## 8. Rollback cost

A plain revert and release. No state, config, or data changes. Existing lifelines pick up the supervisor change on their normal update.

---

## Conclusion

Safe to ship. It removes a false kill path and a crash path, and every real-death route stays in place through the /health checks, with the longer bounds in section 1.

## Second-pass review (if required)

**Independent read of the artifact: concern, resolved.** An independent reviewer read every caller of `isServerSessionAlive` and found no wedge and no dead server left unrestarted forever. Guard rethrow, stdio handling and the regex against live tmux 3.7c wording all concur. Concerns raised and resolved here: the 60-second claim was only the best case (bounds now in section 1); the gone path logged nothing (it now logs tmux's words, and the summary is softened); "names the writer" overreached (reworded); the evidence line credited the wrong test (fixed); the e2e stderr scenario could pass on the policy alone (it now asserts the guard's report).

## Evidence pointers

- Released build 1.3.1693 reproduced the exact FATAL line in a manual run: a stdin write to a child that closed its stdin, under the same handlers. `tests/e2e/closed-pipe-process-survival.test.ts` runs only the patched dist and shows it stays up.
- `tests/unit/supervisor-tmux-probe-unknown.test.ts` runs the real `execFileSync` against stand-in tmux scripts.
- Lifeline log 2026-11-06: GONE at 16:12:16, 16:12:26, 16:16:29, 16:24:16, 16:27:07Z while `logs/server.log` kept writing. Cleanup at about 16:12:37 and 16:16:49Z; FATAL at 16:12:39 and 16:16:49Z. Lifeline times come from nearby entries and are approximate.

## Class-Closure Declaration (display-only mirror)

Modifies a self-triggered controller (the supervisor's restart path) and makes it fire less. Control-loop edge: failed probe to restart is removed; only tmux's own "missing" answer or /health failures can reach `handleUnhealthy`. Steady-state bound and settling brake are unchanged: restart attempts, backoff, and the circuit breaker in `handleUnhealthy`.
