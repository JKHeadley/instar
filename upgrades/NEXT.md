---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13481; multi-machine live-transfer cascade)
---

# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — a moved conversation now advances on follow-ups instead of duplicating

A correctness fix for the multi-machine "move this conversation to my other machine"
feature. After a conversation moved to the backup machine, the backup correctly started
it. But the very next message you sent — a normal follow-up — was handled by code that
always tried to start a session, even though one was already running. Because of how the
session name was stored and then re-prefixed, it could not find the running session and
spawned a duplicate instead. So follow-ups landed in fresh, confused sessions rather than
the moved conversation.

This release makes the receiving machine behave like the normal single-machine path: if a
session for the conversation is already running, the follow-up is delivered straight into
it; a new session is started only when there isn't one, and always under a clean name so
the re-prefix problem cannot recur.

## Summary of New Capabilities

- The owner-side forwarded-message handler injects a follow-up into the already-running
  moved session (with the standard message prefix the session expects) instead of
  re-spawning.
- A session is spawned only when none is running, always under a clean topic-derived
  name, never the already-prefixed stored name.

## What to Tell Your User

If you run your agent across more than one machine and move a conversation to another one,
follow-up messages now continue in the same moved conversation instead of starting a new,
forgetful one each time. Only relevant when the multi-machine session pool is on;
single-machine agents are unaffected. Nothing to configure.

## Evidence

- Confirmed in code: the stored session name was the already-prefixed tmux name, which
  the spawn function prefixed again, so an existing session was never found and a
  duplicate was spawned on every follow-up.
- Wiring, tests/unit/session-pool-activation-wiring.test.ts: the owner-side handler
  injects into a live session before any spawn, uses the Telegram-aware inject plus
  injection tracking, and spawns under a clean topic-derived name.
- 52 session-pool and adapter tests pass; tsc --noEmit clean.
- Note: unit-verified; the live confirmation that a moved session answers a follow-up
  correctly follows once the second machine's CLI is logged in.
- Spec, docs/specs/owner-side-followup-inject.md plus the .eli16.md sibling.
