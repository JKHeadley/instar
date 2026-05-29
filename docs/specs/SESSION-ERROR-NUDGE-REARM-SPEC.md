---
title: "Session Error-Nudge Re-Arm — survive repeated transient API errors in a long-running session"
status: approved
approved: true
approved-by: Justin
approved-via: Telegram topic 13481 (2026-05-29 — "Looks like you got stopped again please fix this as well and deploy the fix for all agents", in direct response to the screenshot showing an autonomous session stranded idle after an 'API Error: 500'. Explicit go to fix + deploy fleet-wide.)
review-convergence: "tactical-hotfix-2026-05-29 (single-author, code-grounded — root-cause traced in SessionManager.ts; same urgency class as the silently-stopped-trio tactical hotfix)"
---

# Session Error-Nudge Re-Arm

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

## Non-goals

- No new sentinel/watchdog. A parallel autonomous-resumption watchdog was considered and
  rejected: it would double-nudge the same idle pane against this existing mechanism.
  The single source of truth is `SessionManager`'s error-nudge; it just needed re-arming.
