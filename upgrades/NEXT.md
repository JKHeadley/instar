---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13481; multi-machine live-transfer cascade)
---

# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — a conversation moved to your other machine keeps its memory

A quality step for the multi-machine "move this conversation to my other machine"
feature. When a conversation moved to the backup machine, that machine started the
session fresh from its own records — which were empty for that conversation (it had
never been the one talking to you). So the moved conversation effectively forgot
everything that came before it.

This release has the receiving machine fetch the recent history from the machine that
was serving the conversation, and seed the moved session with it. So the conversation
picks up where it left off instead of resetting. It's best-effort: if the other machine
can't be reached, the session still starts (just without the prior history, as before),
so it never blocks the move.

## Summary of New Capabilities

- New `formatForwardedTopicContext` helper formats relayed history into the standard
  thread-history block.
- `spawnSessionForTopic` accepts an optional pre-computed context, used verbatim when
  provided (skipping the empty-on-a-standby local sources); single-machine behavior is
  unchanged when it is absent.
- The owner-side resume fetches the router's recent topic messages and passes them, so a
  moved session continues the conversation.

## What to Tell Your User

If you run your agent across more than one machine and move a conversation to another
one, the moved conversation now remembers what you were talking about — the receiving
machine pulls the recent history from the machine that was serving it. Only relevant
when the multi-machine session pool is on; single-machine agents are unaffected. Nothing
to configure.

## Evidence

- Confirmed in code: on a standby, a moved session was spawned with no TopicMemory and an
  empty local message history, so it started with no prior conversation context.
- Unit, `tests/unit/ForwardedTopicContext.test.ts`: the formatter over empty history,
  multi-message threads with attribution, sender/timestamp fallbacks, and the
  per-message length cap.
- Wiring, `tests/unit/session-pool-activation-wiring.test.ts`: the owner-side bridge
  still spawns and fails safe with the history fetch wrapped around it.
- 51 session-pool + adapter tests pass; tsc --noEmit clean.
- Note: unit-verified; the live confirmation that a moved session retains its context
  follows once the second machine's CLI is logged in.
- Spec, `docs/specs/moved-session-context-relay.md` plus the .eli16.md sibling.
