# Side effects — Session error-nudge re-arm (fleet-wide fix)

## What this changes
`src/core/SessionManager.ts` — the post-API-error idle nudge is now re-armable instead of once-per-session-forever.
- `errorNudgedSessions` is now a per-idle-episode flag: set on nudge, CLEARED in the existing "Session is active" branch (recovery), so a long-running session that hits a SECOND transient API error is nudged again.
- New `errorNudgeTotal: Map` + `MAX_ERROR_NUDGES_PER_SESSION` (50) bound runaway: a session flapping error→nudge→error without truly recovering stops being nudged and falls through to the normal zombie-kill path. Cleared on `sessionComplete`.
- New pure exported `shouldErrorNudge(armedThisEpisode, totalNudges, max)` is the gate the production code routes through (unit-testable boundary).

## Why
A 2026-05-29 autonomous run was found idle after an `API Error: 500` — the SECOND such stop. Root cause: the nudge fired once per session, ever (the guard set was only cleared on sessionComplete). The in-session autonomous Stop hook cannot cover this (it fires only on a clean Stop, not an errored turn). Spec: docs/specs/SESSION-ERROR-NUDGE-REARM-SPEC.md.

## Risk / blast radius
Low + bounded. Behavior change is strictly MORE recovery (re-nudge on a fresh error episode) with a hard lifetime cap (50) so it can never nudge forever or burn quota. The rate-limit/throttle path is untouched (still hands off to RateLimitSentinel, consumes no nudge token). Server-side code → deploys fleet-wide via the normal release/auto-update; no agent-file or config change, no migrator entry needed.

## Tests
- `tests/unit/session-error-nudge.test.ts` — +behavioral coverage of shouldErrorNudge (both sides of every branch: armed/not-armed, under/over cap, re-arm-after-recovery) + structural pins (episode flag cleared in the active branch; gate routes through shouldErrorNudge).
- SessionManager-adjacent suites (behavioral, terminate, zombie-kill-topic-binding, reap-detect, injection, multishot-recovery) all green — no regression to the idle/kill path.
