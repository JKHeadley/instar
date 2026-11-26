# Side-Effects Review — rerouted job sessions stuck at an expired login are ended

**Version / slug:** `rerouted-job-login-expired`
**Date:** `2026-10-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (session lifecycle change) — see below`

## Summary of the change

Adds a third check to the rerouted-interactive branch of `SessionManager`'s monitor tick (`completionMode === 'pattern'` sessions: rerouted jobs, A2A and dispatch one-shots). Besides (a) the completion sentinel and (b) the hard lifetime cap, step (c) `endIfLoginExpired` captures the pane, asks the new pure classifier `classifyLoginExpired` (`src/core/LoginExpiredSignature.ts`) whether the live tail is Claude Code's own expired-login frame, and, if the frame is still present 60 s after it was first seen, terminates the session (`rerouted-login-expired`, `finalStatus: 'killed'`) and reports a degradation naming the login folder. Files: `src/core/LoginExpiredSignature.ts` (new), `src/core/SessionManager.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, tests. Live cause: 2026-10-18 Mac Studio, both job slots held for 8 h by sessions idling at `⏺ Login expired · Please run /login`, so no scheduled job ran.

## Decision-point inventory

- `SessionManager.monitorTick` rerouted branch — **modify** — adds one terminate condition (expired-login frame present across a 60 s dwell), placed after the existing sentinel and lifetime checks, with the same protected/standing exclusions.
- `classifyLoginExpired` — **add** — pure signal (no I/O, no authority); consumed only by the step above.

---

## 1. Over-block

The only "block" is ending a session. Inputs that could wrongly match: a session whose live tail has a glyph-led line that BEGINS with `Login expired` / `OAuth token has expired` / `Invalid API key … /login` / `Please run /login` while the session is in fact healthy. Claude Code prints those lines only for its own auth failure; an assistant message discussing the error starts with other words (tested: `⏺ Root cause: the job hit "Login expired …"` does not match). A model reply that literally begins with "Login expired" as its first words, glyph-led, would match; it would also have to stay the last screen for 60 s with no further output. Judged negligible, and the cost of a false end is one job run that reruns on its next trigger. Interactive (non-rerouted) sessions are never touched: the check sits inside the `completionMode === 'pattern'` branch.

## 2. Under-block

- A login failure printed in a different wording (a future Claude Code string) is missed; the session falls back to the 480-min cap as before. The frame list is in one place to extend.
- The pool can keep handing the same expired login to the next job until the QuotaPoller marks it `needs-reauth` (it did, eventually, on 2026-10-18). Each such job now costs ~1–2 min of a slot instead of 8 h. Making placement react to this signal would give this detector authority over pool state; deliberately not done.
- A non-rerouted (headless `-p`) job hitting the same failure exits on its own, so it never had this problem.
- The kill is recorded as a job `timeout`, which CrashLoopPauser ignores, and lands ~60–90 s in (past its short-run rule). So a frequently scheduled job on a dead login keeps costing about a minute per run, with no automatic pause, until the QuotaPoller marks the login `needs-reauth`. Accepted: bounded by the job's cadence, and far cheaper than the 8-hour hold.

## 3. Level-of-abstraction fit

Right layer. The rerouted branch already owns "when does a held REPL session end?" (sentinel, lifetime cap). The pane-signature detector is a pure function alongside `IdleErrorClassifier` and reuses the shared `paneTail` helpers rather than adding a third tail definition. It was kept out of `StuckSignatureClassifier` on purpose: adding a `StuckKind` would change PresenceProxy's user-facing standby text and the stall-class catalogue (`SENTINEL_KIND_TO_STALL_CLASS`, ratcheted against framework stall-coverage matrices) — a larger, separate change.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

`classifyLoginExpired` is a brittle, cheap detector with no authority. The terminate decision lives in the existing rerouted-session lifecycle owner, which already terminates these sessions on a deterministic condition (the lifetime cap). The new condition is not a judgment call: a session whose screen is Claude's own "Login expired · Please run /login" cannot make progress (the REPL refuses every turn until `/login`), so it is an enumerable dead state, guarded by a strict frame match plus a dwell. It does not block messages, gate information or touch pool/account authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The state is enumerable (the CLI's own fatal auth frame); there is no competing liveness/work signal that could make a session at that screen productive.

## 5. Interactions

- **Shadowing:** runs after the sentinel check (a finished session is still reaped as success) and after the lifetime cap (unchanged). It does not shadow either.
- **Double-fire:** `terminateSession` is CAS-guarded on status; the SessionReaper and the lifetime cap cannot double-end the session. `loginExpiredFirstSeen` is cleared on terminate and evicted for non-running sessions.
- **Races:** one extra `captureOutputMaybeAsync` (40 lines) per rerouted session per tick, bounded by `maxRerouted` (6 here). Capture failure returns false (re-checked next tick).
- **Feedback loops:** the job reruns on its next cron trigger; placement may pick the same login again → ended again after ~1 min. Bounded by the job's own cadence; it never retries on its own.
- **Resume queue:** the terminate call passes `workEvidence: []` explicitly (the documented "killer proved idle" lever). Without it, `terminateSession` would fall back to `reapGuard.workEvidence()`, and a REPL with live MCP children could be stamped `active-process` → `midWork`, so a topic-bound rerouted one-shot could be revived onto the same dead login (raised by the second-pass reviewer; fixed, and the test asserts `endedWorkEvidence` is absent).

## 6. External surfaces

- Other agents on the machine: none.
- Install base: rerouted job sessions at an expired login end in ~1 min instead of 8 h; one new degradation feature id.
- External systems: none.
- Persistent state: none new (in-memory map only); the reap-log gains rows with the new reason.
- Operator surface: no new operator action. The fix for the underlying login is the existing sign-in repair (dashboard Subscriptions tab).

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's SessionManager watches its own tmux sessions under its own logins. No notices to users (degradation reports only, which already follow the per-machine degradation path), no durable state, no URLs.

## 8. Rollback cost

Pure code change; revert and ship a patch. No persistent state. The CLAUDE.md bullet would remain on migrated agents (harmless text); a revert can drop it from the template, and the existing marker-sniff makes a later re-add idempotent.

---

## Conclusion

The change closes the specific gap that froze the Mac Studio's job schedule on 2026-10-18 with a strict, dwell-gated detector and no new authority. Kept deliberately narrow (rerouted branch only, no pool-state change, no new user-facing text). Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only)
**Independent read of the artifact: concur**

Concurred, with six points. Acted on: (1) pass `workEvidence: []` so the end never marks the session mid-work and queues a revival onto the same login — fixed; (2) state plainly that a frequently scheduled job on a dead login costs ~1 min per run until the pool marks the login — added to §2; (5) add tests for a protected session showing the frame and for eviction of a non-running session's sighting — added. Confirmed by the reviewer without change: `killed` maps to a job `timeout` (JobScheduler), the dwell logic and its cleanup are sound, placement after the sentinel and lifetime checks is right, the frame match is precise, the tests drive the real `maintenanceTick`, and the change is signal-vs-authority compliant.

---

## Evidence pointers

Live: `GET /jobs` and `GET /sessions` on the Mac Studio at 2026-10-18T20:47Z; pane of `echo-job-overseer-maintenance-mve1qxb5`; `server-stderr.log` line "exceeded its hard lifetime (480m > 480m)". Tests listed in `upgrades/next/rerouted-job-login-expired.md`.

---

## Class-Closure Declaration (display-only mirror)

This change modifies a self-triggered controller (the rerouted-session monitor gains a terminate path), so the `unbounded-self-action` convergence argument applies:

- **`defectClass`:** `unbounded-self-action` (controller modified)
- **`closure`:** `guard`
- **`guardEvidence`:** `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: control-loop edge — a terminate fires only for a session already running whose own screen shows the fatal frame for ≥60 s; steady-state bound — at most one terminate per session lifetime (the session is gone after it), so kills ≤ rerouted spawns, which are bounded by maxRerouted and the scheduler's job cadence; settling brake — the controller never spawns or retries anything itself; recurrence happens only through the job's next cron trigger.}`
