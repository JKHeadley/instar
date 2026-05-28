# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fixed a runaway credit-burn bug: LLM call loops no longer keep hammering the
provider after you hit a usage or spend limit.**

Instar runs small background LLM calls to watch your sessions (for example, the
per-tick check that detects when a session is blocked on a prompt). Until now,
if one of those calls came back with a usage/rate/spend-limit error, the loop
swallowed the error and tried again on the very next tick — with no backoff. If
your account had auto-reload turned on, each retry refueled and re-burned. A
real agent in the wild burned $452 of $455 in usage credits this way over a
couple of days before anyone noticed.

There is now an **account-global circuit breaker** in front of every internal
LLM call. The moment the provider reports a usage/rate/spend limit, the breaker
opens and *all* background LLM-backed work pauses — without spawning another
`claude` subprocess, so it costs nothing while paused. After a cool-down window
(15 minutes by default) it sends exactly one quiet probe; if the limit has
lifted it closes and resumes automatically, and if not it waits another window.
It is wired at the single provider-construction chokepoint, so every feature —
current and future — is covered with no per-feature work.

This is reactive (it listens to the provider's own "you're over limit" signal)
and complements the existing volume-based burn-detection, which reacts to
statistical token-share over a longer window.

## What to Tell Your User

Your agent can no longer burn through your credits by repeatedly calling the
model after you've hit a usage or spend limit. The instant the provider says
you're over your limit, background model work pauses on its own, costs nothing
while paused, and quietly resumes once the limit lifts. This is on by default —
no setup needed. If you ever want to tune the cool-down window or turn it off,
there's an optional circuit-breaker setting in your config, but the safe
defaults are designed to just work.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Account-global LLM rate-limit circuit breaker | Automatic. When the provider returns a usage/rate/spend-limit error, all background LLM-backed work pauses (no subprocess spawned) and self-heals via a single probe after the cool-down. |
| Tunable cool-down / kill switch | Optional `intelligence.circuitBreaker` in `.instar/config.json`: `enabled` (default true) and `openMs` (default 900000 = 15 min). Absent config uses the safe defaults, so existing agents are protected with no changes. |

## Evidence

**Reproduction (the incident pattern), reproduced as an automated test:** a fake
`claude` binary that records each spawn to an on-disk counter and exits with
"Claude AI usage limit reached" on stderr.
`tests/integration/llm-circuit-breaker-chokepoint.test.ts` builds two providers
through the real `buildIntelligenceProvider` factory and drives them:

- Before fix (old behaviour): every `evaluate()` call spawns the binary →
  unbounded spawns while limited (this is exactly the $452 burn).
- After fix (observed in the test): the first call spawns once and trips the
  breaker; the next 5 calls — and a call through a *second, independently built*
  provider — all reject with `LlmCircuitOpenError` and the spawn counter stays
  at **1**. Zero additional subprocesses, proving the burn is stopped and the
  breaker is account-global.

39 new circuit-breaker tests pass (state machine both-sides-of-boundary, the
rate-limit classifier on true-positive and unrelated-error strings, and the
chokepoint wiring). `tsc --noEmit` clean. The server log emits
`[llm-circuit] OPEN: …` / `[llm-circuit] closing: …` lines on each transition.

---

**Phase 2 of the unified session-lifecycle robustness work (spec
`docs/specs/unified-session-lifecycle-robustness.md`).** The four remaining
autonomous session killers — the SessionWatchdog, OrphanProcessReaper,
SessionRecovery (kill-to-respawn), and the scheduler's wake-reaper — are now
funneled through the single ReapAuthority that shipped in Phase 1. Each one
gains the careful KEEP-checks and the awake-machine lease gate the previous
killer-of-the-week didn't have, plus structural fixes to a few long-standing
near-misses.

What landed:

- **#5 SessionWatchdog.** The final escalation level (the session-kill that
  fires after Ctrl+C / SIGTERM / SIGKILL all failed to free a stuck child) now
  routes through `terminateSession('watchdog-stuck', terminal/killed)` instead
  of a raw `tmux kill-session`. If the authority's KEEP-guards refuse the kill
  (a relay lease, an active subagent, a recent user message, etc.), the
  watchdog STANDS DOWN — clears its escalation state, logs the exact refusal
  reason, and lets the §P5 backstop own the operator-decision escalation.
- **#6 OrphanProcessReaper.** Three changes. (a) Orphan classification is now
  EXACT-id membership in `listKnownTmuxSessions()`, not project-prefix
  startsWith — so a user-created `tmux new -s the-portal-myhand` is `external`,
  not orphan, and the reaper cannot false-reap a user pane. (b) The 60-minute
  age threshold is necessary, not sufficient: a new `processHasActiveChildren`
  work-check (pgrep -P) vetoes the kill when the orphan still has running
  children, and the deferred path logs a `Kept orphan PID … work check vetoed
  reap` action. (c) When the orphan's tmux name matches a currently-tracked
  session, the kill goes through the ReapAuthority for the lifecycle events +
  reap-log entry.
- **#8 SessionRecovery.** A single shared `killForRecovery()` helper consults
  `hasActiveProcesses` before every kill-to-respawn — if the pane is producing
  work, the JSONL stall/crash reading is unreliable and the recovery defers
  with a structured `deferred-still-working` result. All four recovery paths
  (stall, context-exhaustion, crash, error-loop) route through this helper.
  The actual kill goes through `terminateSession('session-recovery',
  recovery-bounce, bypassRecoveryFlag:true)` so the §P3 "shut down" notice
  stays silent on a bounce (which is not a disappearance) and the reap-log
  records the recovery-bounce disposition. `bypassRecoveryFlag` is narrowly
  scoped to the `recovery-in-flight` KEEP-guard reason — all other KEEP-
  guards still apply, so a session mid-conversation isn't killed-to-respawn
  under the cover of "recovery."
- **#9 wake-reaper.** Three changes. (a) The threshold-check now uses
  CUMULATIVE wall-time-asleep during the run (the new
  `SleepWakeDetector.getCumulativeSleepMsBetween()`), not the single last
  `sleepDurationSeconds` event — a job that spanned multiple sleeps was
  previously credited only the last sleep and reaped early. (b) The P1/P2 work
  gate keeps a session whose process is still producing work, regardless of
  clock. (c) The kill routes through `terminateSession('wake-reaper',
  terminal/killed)` when tracked.

All four killers now share the same brain — the structural guarantee the
spec's audit named when it found "is this session alive/dead/stuck/working?"
answered ad-hoc in eight different places.

## What to Tell Your User

- Every part of the agent that can shut a session down — the stuck-child
  watchdog, the orphan-process cleanup, the crash-recovery, and the after-
  sleep cleanup — now goes through the same careful gatekeeper that the boot
  cleanup uses. None of them can quietly kill a session that might still be
  working.
- The watchdog's last-resort session kill, the crash-recovery's restart, and
  the after-sleep cleanup all show up in the reap-log with the reason, so the
  "where did my session go?" answer is always there.
- A crash-recovery restart (kill + respawn fresh) stays quiet — it's a bounce,
  not a disappearance — but it's still logged.
- The orphan-process cleanup can no longer accidentally classify a tmux pane
  you started yourself as one of mine, and it will defer the kill if the
  orphan still has active child processes.
- After your machine sleeps and wakes, the job cleanup correctly subtracts the
  total sleep time (across multiple sleeps if needed) before deciding a job
  ran too long, so a job that was paused while you closed the lid isn't
  marked stuck.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Every autonomous killer routes through the single ReapAuthority | Automatic — the watchdog, orphan reaper, crash-recovery, and wake-reaper all funnel through `terminateSession`. |
| Recovery-bounce disposition stays silent in the "shut down" notice | Automatic — a kill-to-respawn doesn't pretend a session vanished; it still lands in the reap-log. |
| Orphan reaper: exact-id classification + work-check + ReapAuthority routing | Automatic — `listKnownTmuxSessions()` replaces the prefix match; `processHasActiveChildren` vetoes reaping a working orphan. |
| Wake-reaper: cumulative-sleep math + P1/P2 work gate | Automatic — multi-sleep runs no longer reaped early; an actively-working session is kept regardless of clock. |

## Evidence

- All Phase 1 unit/integration/e2e tests remain green, plus 14 new Phase-2
  wiring contracts (SessionWatchdog → ReapAuthority routing + KEEP stand-down,
  OrphanProcessReaper exact-id + work-check + P0, SessionRecovery
  killForRecovery + recovery-bounce + bypassRecoveryFlag scope, wake-reaper
  cumulative-sleep + P1/P2 + P0), 6 new SleepWakeDetector cumulative-sleep
  math tests, and the existing JobScheduler reaper suite (7) updated to the
  new async + effective-elapsed contract.
- `tsc --noEmit` clean. Existing SessionWatchdog (58), OrphanProcessReaper
  (9), SessionRecovery (9), terminate-CAS (9), session-timeout/activity-aware
  (4+6) tests all still pass.
