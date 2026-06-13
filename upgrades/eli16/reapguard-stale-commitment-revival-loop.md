# Stale-commitment kill→revive loop — Plain-English Overview

> The one-line version: a session that finished its work but had an old, untouched promise still on the books was being killed (correctly) and then revived (incorrectly) over and over, forever. This stops the revival half from firing on a stale promise.

## The problem in one breath

Today 13 idle sessions across 6 different topics were age-killed and then brought back to life, again and again, in a loop. Every single one was idle — its turn was finished, nothing was running — and the *only* reason the system revived it was that a commitment ("I'll keep you posted") was still registered on that topic. Many of those commitments were long-since done; they just were never marked delivered.

## What already exists

The reaper has one shared "is it safe to end this session?" guard with two halves:

- **The kill half** (`evaluate()`) already knows a commitment goes *stale*. If the topic has had no user message for 8 hours, the commitment is treated as abandoned and no longer keeps the session alive — so an idle session with only a stale promise is correctly reaped. (This staleness rule was added back on 2026-06-06.)
- **The revive half** (`workEvidence()`) decides whether a killed session had real interrupted *work* worth bringing back. It tags the session with evidence like "a build was running" or "a sub-agent was live" — and, until now, "an open commitment exists."

## What this changes

One line. The revive half now applies the **same 8-hour staleness gate** the kill half already uses. So an open commitment only counts as "interrupted work worth reviving" while the topic has had a user message within 8 hours.

The result: the two halves finally agree. A stale commitment neither keeps a session alive *nor* revives it. A *fresh* commitment keeps the session alive in the first place, so it never needs reviving. The loop's engine — kill (stale) then revive (commitment) — is gone.

## Why this is safe

It can only ever revive **less**, never more. A session that was genuinely doing work when it died still carries its real work signals (a live build, an active sub-agent, a pending message, a running process) — those are untouched, and a busy session is never age-killed in the first place. The only revivals removed are exactly the harmful ones: an idle session resurrected to "finish" a promise that was already done. Promises still get their own follow-through from the commitment system (the beacon and the overdue-commitment job) — that's the right owner for a promise, not a respawned session burning a fresh turn each time.

## What you'll notice

Fewer "🪦 your session was shut down — a restart is queued" messages on topics where nothing was actually unfinished. The looping topics (this one included) settle down. Nothing else changes.
