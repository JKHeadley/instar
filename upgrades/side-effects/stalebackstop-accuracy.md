# Side-Effects Review — StaleBackstop detection accuracy (PR2 / D5)

## What changed (mechanically)

`StaleSessionBackstop` no longer cries wolf on healthy long-running sessions:
1. **Protected sessions are never escalated.** New `isProtectedSession?(session)` dep
   (wired in server.ts to the reaper's `getProtectedSessions()`, matched by tmux name
   or session name). A protected session — one the operator deliberately keeps alive —
   skips BOTH escalation paths (no-progress and long-indeterminate).
2. **Conversational/autonomous sessions get a forgiving window.** New
   `conversationalEscalateMinutes` option (default 180, clamped to ≥ the job window).
   The no-progress threshold is now `session.jobSlug ? unverifiableEscalateMinutes (30)
   : max(conversationalEscalateMinutes, unverifiableEscalateMinutes)`. A job runs to
   completion (strict 30-min window); a conversational/autonomous session legitimately
   idles between turns and while waiting on multi-minute tool calls, so it gets 180.

## Blast radius

- The fake-work guards (`hasForwardProgress`: tail-hash + cpu-seconds delta) are
  UNTOUCHED — wedge detection is unchanged; this only widens the no-progress WINDOW for
  conversational sessions and exempts protected ones.
- A genuinely-wedged JOB still escalates at 30 min (unchanged).
- A genuinely-wedged conversational session still escalates — just at 180 min, not 30.
  Combined with PR1's calm lane, even that is a single calm heads-up, not topic-spam.
- Config additive + defaulted; absent config → defaults apply (180 / protected-from-reaper).

## Failure modes considered

- **conversationalEscalateMinutes mis-set below the job window**: clamped up via
  `max(...)` at the decision site, so it can never be MORE aggressive than the job window.
- **isProtectedSession absent** (older wiring / tests): optional-chained → no session
  treated as protected (prior behavior), never throws.
- **Protected list by name vs id**: matched against both `tmuxSession` and `name`.

## Non-goals

- Does NOT change delivery (that's PR1's lane).
- Does NOT auto-kill anything (the backstop remains signal-only).

## Reversibility

`monitoring.staleBackstop.conversationalEscalateMinutes: 30` restores the old uniform
window; protection follows the existing `protectedSessions` list. Additive only.

## Tests

Unit (stale-session-backstop.test.ts): protected session never escalates; the
conversational-vs-job threshold split (a healthy long conversational session at 35 min
does NOT escalate while a wedged job DOES). Existing mechanism tests pinned to the 30-min
window via `conversationalEscalateMinutes: M`. 82 standards + backstop tests green; tsc
clean. (Also: bumped the no-silent-fallbacks baseline 458→459 for PR1's lane fallback, and
tracked main's untacked `/secrets/sync-status` migrator section — both per Zero-Failure.)
