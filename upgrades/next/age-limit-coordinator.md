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

The session's transcript shows its background watch ran until 11 seconds
before the kill, and a background shell counts as a live child process.

- The age gate remembers when it last saw each over-age session working.
  "Working" is the unchanged three-probe decision reading non-idle: a live
  child process, fresh transcript writes, or a pane tail with no
  `IDLE_PROMPT_PATTERNS` match (an empty or unreadable tail also reads
  non-idle, conservatively, as before). For 10 minutes after the last such
  sample (`AGE_GATE_RECENT_WORK_MS`) the session still counts as working, so
  one blind sample cannot kill it. The round-1 quoted-footer ("esc to
  interrupt") exemption is gone.
- Each monitor tick drops that memory for sessions that are no longer
  running, so it stays bounded.

The memory expires 10 minutes after the last non-idle sample. A later tick
that reads idle can then age-kill the session, still subject to the unchanged
KEEP guards and backoff. This is not an unconditional bound after work really
stops: while the pane classifier keeps reading non-idle, the session is kept,
as it was before this change. The pane classifier and process probe remain
imperfect evidence, and the claudeSessionId rotation that blinded the
transcript probe is not repaired here.

## Evidence

- `tests/unit/session-manager-terminate.test.ts` drives the real monitor tick:
  - Quoted "esc to interrupt" text left on an idle pane does not keep it
    alive: past the grace it is age-killed.
  - The memory is dropped for a session that ended some other way, and kept
    for one still running.
  - Replaying the incident: a tick sees a live child process, then one tick
    where every probe reads idle. The session is kept. Eleven minutes of quiet
    later it is age-killed (`status: killed`, `endedReason: age-limit`).
  - The replay fails on origin/main; the other two fail on the first version
    of this fix.
- `tests/unit/session-timeout-activity-aware.test.ts` covers both sides of the
  new `recentlySeenWorking` input to `isAgeGateTrulyIdle`.

## What to Tell Your User

If I'm in the middle of long work, the session age limit no longer shuts me
down during a brief pause between steps. It still ends sessions that have
really stopped.

## Summary of New Capabilities

- Over-age sessions are only ended when the existing activity probes have not
  read them as working for 10 minutes.
