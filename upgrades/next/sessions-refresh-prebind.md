# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`POST /sessions/refresh` now answers target refusals synchronously instead of returning 202 "Refresh scheduled" and refusing 500ms later in the server log only (EVO-025, from LRN-034). `SessionRefresh` gains a read-only `precheckRefusal(sessionName)` that runs the same detect phase as `refreshSession()` (now shared via a private `resolveTarget()`), the in-flight check, and a non-recording rate-limit check. The route calls it before the busy precheck: `not_telegram_bound`, `session_not_found`, `refresh_in_progress` and `slack_respawner_unwired` return 409 `{code, error}`; `rate_limited` returns 429. When the name given is a running session's display name, the refusal names its `tmuxSession` (a hint, never a silent remap — display names are not unique). `refreshSession()` still re-checks everything after the 202.

## What to Tell Your User

If you (or I) ask to restart a session by the wrong name, you now hear right away that it can't be done and which name to use, instead of being told the restart was scheduled when it never happened.

## Summary of New Capabilities

- Session restart requests report refusals immediately, with the correct session name when a display name was used.

## Evidence

- Tests: `tests/unit/SessionRefresh.test.ts` (+6: null for a restartable session, not_telegram_bound, display-name hint names the tmux session and the authoritative path kills nothing, no hint for unknown names, session_not_found, rate_limited reported without consuming budget); `tests/unit/sessions-refresh-route.test.ts` (+2: 409 not 202 for an unbindable name with refreshSession never called, 429 for rate_limited). Existing Slack-arm, integration and e2e swap-continuity suites pass unchanged. `tsc` clean.
