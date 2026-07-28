# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The automatic recovery nudge that restarts a session after a transient API error
(e.g. "API Error: 500") is now **re-armable**. Previously a session was nudged at
most once for its entire lifetime — the guard that prevented infinite nudge loops
was only cleared when the session ended. A long-running autonomous session that hit
a SECOND transient API error was therefore never re-nudged: it sat idle at the
prompt until a human poked it, and was eventually zombie-killed, silently losing the
run.

Now the nudge guard is per-idle-episode: it is cleared the moment the session goes
active again, so each fresh API-error episode gets its own nudge. A lifetime cap
(50 nudges per session) bounds a session that flaps without ever recovering, so it
still falls through to the normal zombie-kill path rather than being nudged forever.

This closes a gap the in-session autonomous Stop hook structurally cannot cover — the
Stop hook only fires on a clean turn end, never on an errored turn, so the recovery
has to come from the out-of-process session monitor where this nudge already lived.

Beyond the re-arm, the **intelligent backoff recovery** that already existed for
rate-limit/throttle errors (RateLimitSentinel: back off before retrying, tell you
you're not dropped, verify the retry took, escalate if it never does) now covers the
**whole class of transient API errors** — 500/502/503, overloaded, timeouts, connection
drops — not just rate limits. A generic API error gets the same intelligent treatment,
with a fast first retry (≈5s, since these usually clear quickly) escalating gently if it
persists. Future-proof: the error set is driven by one pattern list, so adding a new
transient pattern automatically routes it through the backoff recovery.

## What to Tell Your User

- **Long autonomous runs now survive repeated transient API hiccups on their own**:
  "If the AI service has a momentary error mid-task, I tap myself back into work — and
  now I do that every time it happens during a long run, not just the first time. So a
  multi-hour autonomous job won't silently freeze after a second hiccup anymore."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Re-armable API-error recovery nudge | Automatic — every agent gets it on update. A session idle after a transient API error is re-nudged to continue, once per error episode, capped at 50 per session lifetime. No config. |

## Evidence

Unit coverage in `tests/unit/session-error-nudge.test.ts` exercises the pure
`shouldErrorNudge()` gate across every branch (already-nudged-this-episode → skip,
fresh episode under the cap → nudge, at/over the lifetime cap → skip, re-arm after
recovery → nudge again) and pins the structural invariants (the episode guard is
cleared in the "Session is active" branch; the production path routes through the
gate). The SessionManager behavioral + idle/kill suites remain green — no regression.
Spec: `docs/specs/SESSION-ERROR-NUDGE-REARM-SPEC.md`.
