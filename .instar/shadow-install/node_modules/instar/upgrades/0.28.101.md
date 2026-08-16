# Upgrade Notes (Unreleased)

## What Changed

SessionManager's wall-clock-age timeout-kill was reaping long-running sessions that were still actively working. Before this fix, any session whose `startedAt` was past `maxDurationMinutes + 20% buffer` (default 240m + 48m = 288m) got killed unconditionally — even if it was producing tool calls every few seconds. That reaped multi-hour autonomous flows (spec convergence loops, multi-phase `/instar-dev` builds driving multiple PRs to merge, multi-hour `/loop` tasks) and took their background sub-agents with them. The kill is now gated on a true-idle check: a session is timeout-killed only when it is over the age limit AND truly idle (terminal at idle prompt AND no non-baseline child processes). Sessions over the age limit but still working are deferred until they go idle, at which point the existing idle-detection block catches them. A new per-session log marker keeps the deferred-kill warning to once per session so the log doesn't fill up.

### fix(scheduler): activity-aware SessionManager timeout-kill

- **Wall-clock kill is now gated.** `SessionManager.monitor.timeout-kill` (the existing block at lines 466+ of `src/core/SessionManager.ts`) now consults `captureOutput` for idle-prompt patterns AND `hasActiveProcesses` for non-baseline child processes BEFORE killing. Sessions producing terminal output or running non-baseline processes are deferred.
- **Fall-through to idle-detection on defer.** If the new gate defers the kill, control falls through to the existing idle-detection block below (lines 504+), which can still catch the session if it actually IS idle. Regression test confirms no `continue;` between the defer log and the falling-through `else`.
- **Deferred-kill warning, once per session.** A new in-memory `Set<string>` (`overAgeButActiveLogged`) tracks sessions that have already been logged as "over age limit but actively working" so the warning fires once per session, not every tick. Format: `Session "X" is past the age limit (Nm > Mm) but is actively working (procs=Y, idleAtPrompt=Z). Deferring kill; the idle-detection block will catch it once it stops producing work.`
- **Same kill path on confirmed idle.** When the activity gate confirms idle, the kill path is byte-identical to pre-fix: same `beforeSessionKill` emit, same `kill-session` execFile, same status transition to `killed`. The kill-on-idle suffix is the new contract: `Session "X" exceeded timeout (Nm > Mm) and is idle. Killing.`
- **No schema, route, or contract changes.** `Session.maxDurationMinutes`, `spawnSession`, the `protectedSessions` opt-out, and `IDLE_PROMPT_KILL_MINUTES` are all unchanged.
- **What's still on the roadmap (separate PRs):** commitment-registry consultation before any kill (consult the integrated-being commitment ledger and defer the kill if open commitments are tracked); orphan-handoff manifests on kill (when a session is killed with background sub-agents in flight, write a recovery manifest per agent so the next session can resume); resume orientation that surfaces orphan-handoff manifests on session respawn.

### Evidence

New test: `tests/unit/session-timeout-activity-aware.test.ts` exercises six structural contracts on the post-fix code:

- the wall-clock check is preserved (necessary precondition);
- the once-per-session log Set is declared;
- the gate consults both `captureOutput` and `hasActiveProcesses`;
- the deferred-kill branch logs "Deferring kill" with "actively working";
- the kill path still fires on confirmed idle with the "and is idle. Killing." suffix;
- there is no `continue;` between the defer log and the falling-through `else`, so the idle-detection block below is reachable.

Pre-existing test suites continue to pass: `tests/unit/session-timeout.test.ts` (4 tests, structural maxDurationMinutes contract) and `tests/unit/session-manager-behavioral.test.ts` (22 tests, the broader behavioral surface).

Production observation pre-fix: the topic-9529 session driving INSTAR-JOBS-AS-AGENTMD Phase 1 was killed twice by the wall-clock check while actively working — 2026-05-12T20:43:37Z and 2026-05-13T01:47:37Z, both at the 288m mark, both with in-flight background sub-agents (Phase 1a's was finished and merged; Phase 1b's was mid-build and was lost, requiring restart from a WIP checkpoint).

Side-effects review: `upgrades/side-effects/sessionmgr-activity-aware-timeout.md` — covers over-block (the fix REMOVES an over-block), under-block (no new gaps; pathological hung-but-active sessions are not newly missed), level-of-abstraction fit (SessionManager already owns this authority), signal-vs-authority compliance (no new gates; tightens precondition on existing kill authority by consulting two existing detectors), interactions (gate runs before idle-detection block; fall-through is preserved; no shadowing), external surfaces (deferred-kill warning is new operator-visible output, deduped per-session), and rollback (pure code change, revert restores byte-identical pre-fix behavior).

## What to Tell Your User

Your agent can be in the middle of a multi-hour task — converging on a spec, driving several pull requests to merge, running a long polling loop — and the previous version of Instar would kill the session at the four-hour mark regardless of whether it was still working. After this fix, that kill only happens if the session is genuinely idle: nothing producing terminal output, no non-baseline child processes running. A session producing tool calls every few seconds keeps going. A session that's actually stuck still gets killed, just slightly later, by the existing idle-detection path. No setup, no configuration; the new behavior takes effect on the next agent update.

## Summary of New Capabilities

- **Activity-aware wall-clock timeout-kill** — sessions over the age limit that are still producing terminal output or non-baseline child processes are deferred from the timeout-kill path. The existing idle-detection block catches them once they genuinely stop.
- **Operator-visible deferred-kill log line** — once per session, `[SessionManager] Session "X" is past the age limit (Nm > Mm) but is actively working ...` signals the deferred kill so it's visible in `logs/server.log`.
