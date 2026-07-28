---
title: "Transient-API-Error Recovery — re-arm the nudge + generalize backoff recovery to the whole 5xx/timeout class"
status: approved
approved: true
approved-by: Justin
approved-via: Telegram topic 13481 (2026-05-29 — two messages: (1) "Looks like you got stopped again please fix this as well and deploy the fix for all agents" re: the screenshot of an autonomous session stranded after an 'API Error: 500'; (2) "I thought we already had a sentinel… for the rate limit error, it attempted exponential back off… Does that sentinel not exist? we need something… intelligent enough and general enough that it's future-proof for at least API errors of this type." Explicit go to fix + generalize + deploy fleet-wide.)
review-convergence: "tactical-hotfix-2026-05-29 (single-author, code-grounded — root-cause traced in SessionManager.ts + RateLimitSentinel.ts; same urgency class as the silently-stopped-trio tactical hotfix)"
---

# Transient-API-Error Recovery (Error-Nudge Re-Arm + Backoff Generalization)

## Problem (observed, 2026-05-29, topic 13481)

An 8-hour autonomous run was found idle at the prompt after an `API Error: 500` (a
transient Anthropic server-side error) aborted a turn mid-task. The session did not
resume on its own; it sat idle until the user messaged it. This was the SECOND such
stop in the run — the user's words: "got stopped **again**".

### Root cause

`SessionManager` already nudges a session that goes idle right after an API error:
its `monitorTick` idle-detection path checks the captured terminal against
`TERMINAL_ERROR_PATTERNS` (which includes `'API Error:'` and `'Internal server
error'`), and on a match injects "You hit an API error. Please continue your work…"
via `sendInput`. This is the correct recovery primitive.

The defect: the nudge was gated by `errorNudgedSessions: Set<string>` keyed on session
id, and that set was **only cleared on `sessionComplete`** — i.e. once the session
*ends*. So a session was nudged **once per session, forever**. A long-running
autonomous session that hit a SECOND transient API error (the common case over hours)
was never re-nudged: the first error consumed the single nudge, and every subsequent
error left the session idle until a human intervened. After the idle-kill threshold it
would be zombie-killed — silently losing the run.

The in-session autonomous **Stop hook cannot cover this gap**: it fires only on a
*clean* Stop event, and an API-error abort is not a clean stop. The recovery therefore
has to come from the out-of-process monitor (`SessionManager.monitorTick`), which is
exactly where the error-nudge already lives — it just needed to be re-armable.

## Fix

Make the error-nudge **per-idle-episode** instead of **per-session-forever**, bounded
by a lifetime runaway cap:

1. **Re-arm on recovery.** `errorNudgedSessions` is now an episode flag: it is set when
   we nudge, and **cleared when the session goes active again** (produces output /
   leaves idle — the existing "Session is active" branch that clears `idlePromptSince`).
   A session that recovers and later hits a NEW transient API error gets its own nudge.
2. **Runaway cap.** A new `errorNudgeTotal: Map<sessionId, number>` counts nudges across
   the session's whole lifetime (cleared only on `sessionComplete`). Once it reaches
   `MAX_ERROR_NUDGES_PER_SESSION` (50 — generous for genuinely-transient errors over an
   8h run), the session stops being nudged and falls through to the normal zombie-kill
   path. This bounds a pathological session flapping error→nudge→error that never truly
   recovers, so we never nudge forever or burn quota.
3. **Pure gate.** The nudge decision is the pure, exported `shouldErrorNudge(armedThisEpisode, totalNudges, max)` = `!armedThisEpisode && totalNudges < max`, so the decision boundary is unit-testable without driving the tmux loop.

The rate-limit/throttle path is unchanged (it still hands off to the RateLimitSentinel
and does NOT consume a nudge token). The fix is server-side `SessionManager` code, so it
deploys fleet-wide via the normal release/auto-update path — no agent-installed-file or
config change, hence no PostUpdateMigrator entry needed.

## Tests

- `tests/unit/session-error-nudge.test.ts`:
  - behavioral coverage of `shouldErrorNudge` across every branch (armed→skip,
    not-armed+under-cap→nudge, at/over-cap→skip, re-arm-after-recovery→nudge);
  - structural pins: the episode flag is CLEARED in the "Session is active" branch
    (re-arm), and the production gate routes through `shouldErrorNudge`.
- `tests/unit/session-manager-behavioral.test.ts` + the SessionManager-adjacent suites
  (terminate, zombie-kill, reap-detect, injection, multishot-recovery) remain green — no
  regression to the idle/kill path.

## Part 2 — Generalize the intelligent backoff recovery to the whole transient-API class

The re-arm above fixes the *immediate* nudge, but the immediate nudge is the "dumb"
path: it retries instantly, with no backoff, verify, or escalation. instar already has
the *intelligent* recovery lifecycle — `RateLimitSentinel` — which on a detected error
sends a "backing off, you're not dropped" notice, waits an **exponential backoff**
before re-engaging (so it doesn't re-hit a still-down API or burn quota), **verifies**
the nudge took (JSONL growth), **escalates** after a bounded attempts/window envelope,
and vetoes the zombie-killer while recovery is in flight. But it was scoped ONLY to
**throttle / rate-limit / 529-Overloaded** errors. A generic `API Error: 500` never
reached it.

**Fix:** generalize that lifecycle to the whole transient-API-error class.

- **`RateLimitSentinel` gains an `ApiErrorClass`** (`'throttle' | 'transient-api'`) on
  `report(sessionName, trigger, { errorClass })` (default `'throttle'` — fully
  back-compatible). The lifecycle is identical across classes; only two things differ:
  - **Backoff schedule.** Throttle keeps the long schedule (`[30s,60s,2m,5m,…]` — re-hitting
    a throttle burns quota). `'transient-api'` uses a **fast** schedule
    (`transientApiBackoffScheduleMs` = `[5s,15s,30s,60s,2m,5m]`) because a 500/timeout
    usually clears in seconds — first retry is quick, then escalates gently.
  - **User wording.** "transient API error … retrying" vs "server-side throttle … backing off".
- **`SessionManager`** routes the generic `TERMINAL_ERROR_PATTERNS` idle case to the
  sentinel: when an `apiErrorAtIdle` listener is wired (production), it emits that signal
  and hands off (no immediate retry that could re-hit a down API), exactly mirroring the
  existing `rateLimitedAtIdle` handoff. The re-armable immediate nudge (Part 1) remains
  the **fallback** when no sentinel is wired (bare/test).
- **`server.ts`** wires `sessionManager.on('apiErrorAtIdle', name => rateLimitSentinel.report(name, 'idle-error', { errorClass: 'transient-api' }))`.

**Future-proof:** the error class is driven by the existing `TERMINAL_ERROR_PATTERNS`
list (`API Error:`, `Internal server error`, `502`/`503`/`ServiceUnavailable`,
`ETIMEDOUT`, `ECONNREFUSED`, `fetch failed`, …). Adding a new transient pattern there
automatically routes it through the intelligent backoff recovery — no new wiring.

### Part 2 tests
- `tests/unit/RateLimitSentinel.test.ts` — the throttle suite is unchanged (back-compat),
  plus a `errorClass: 'transient-api'` block: fast first backoff (5s, not 30s),
  transient-API-worded notice, full backoff→resume→verify→recovered lifecycle, and the
  recovery state/`listActive` reflecting the class + short schedule.
- `tests/unit/session-error-nudge.test.ts` — the generic-error idle path defers to the
  sentinel via `apiErrorAtIdle` when wired, with the re-armable nudge as the fallback.

## Non-goals

- No new parallel sentinel/watchdog. A standalone autonomous-resumption watchdog was
  considered and rejected: it would double-nudge the same idle pane against the existing
  mechanisms. The single source of truth is `SessionManager`'s idle path → (re-armable
  immediate nudge as fallback) / (the generalized `RateLimitSentinel` lifecycle in
  production). One owner per session, never two.
