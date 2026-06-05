<!-- bump: patch -->

## What Changed

The standby presence watcher no longer reports "agent is actively working"
while a session is actually paused on Claude's session limit. The honest
"paused on its usage limit — resets at HH:MM" message already existed, but
the newer limit-banner wording ("Session limit reached ∙ resets 10:30pm" —
no parenthesized timezone) matched none of its detection patterns, so the
watcher fell back to the generic busy message (the 2026-06-05 topic-2169
incident). Three patterns added; "approaching session limit" deliberately
does not trigger it.

## What to Tell Your User

If a session hits its Claude limit, my check-in messages now say exactly
that — paused, nothing running, resets at HH:MM — instead of claiming I'm
busy while you wait on a silent machine.

## Summary of New Capabilities

- Session-limit banners (all current wordings) produce the honest paused
  message across all three presence tiers.

## Evidence

`tests/unit/presence-proxy-quota.test.ts` 21/21 — 5 new (verbatim incident
banner, comma/middot variants, bare reset time, and two negative cases:
"approaching" and prose "resets"). tsc + lint clean.
