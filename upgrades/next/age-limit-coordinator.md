# The age limit no longer ends a session in the middle of its work

## What Changed

Past its age limit, a session is ended as terminal once the age gate in
`SessionManager`'s monitor tick reads it as idle. On 2026-09-29 the Instar 2.0
coordinating session (920 minutes old, topic 52075) was ended this way two
seconds after its last transcript write. It was mid-turn, just after one of its
background watches finished:

- The idle-prompt patterns are status-bar strings that are also on screen
  mid-turn.
- The watch shell had just exited, so there was no child process.
- The transcript probe was keyed to a claudeSessionId that a hook had briefly
  rotated to an id with no transcript file.

Earlier ticks had seen the watch running, but every tick was judged alone.

- The age gate now reads the pane's mid-turn footer (`paneShowsClaudeWorking`,
  30 raw lines). A pane showing "esc to interrupt" is not idle.
- The age gate remembers when it last saw each over-age session working. For
  10 minutes after that (`AGE_GATE_RECENT_WORK_MS`) the session still counts as
  working, so one blind sample cannot kill it.

A genuinely stale session is still age-killed, at most 10 minutes after it was
last seen working. Every other keep guard is unchanged.

## Evidence

- `tests/unit/session-manager-terminate.test.ts` drives the real monitor tick:
  - A pane showing the mid-turn footer is not age-killed.
  - Replaying the incident: a tick sees a live child process, then one tick
    where every probe reads idle. The session is kept. Eleven minutes of quiet
    later it is age-killed (`status: killed`, `endedReason: age-limit`).
  - Both tests fail on origin/main.
- `tests/unit/session-timeout-activity-aware.test.ts` covers both sides of the
  new `recentlySeenWorking` input to `isAgeGateTrulyIdle`.

## What to Tell Your User

If I'm in the middle of long work, the session age limit no longer shuts me
down during a brief pause between steps. It still ends sessions that have
really stopped.

## Summary of New Capabilities

- Over-age sessions are only ended when the mid-turn footer is absent and they
  have not been seen working for 10 minutes.
