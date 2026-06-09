# ELI16 — Why a session went silent: two topics, one name

## The problem

A conversation (Telegram topic 21624) stopped responding. Messages showed
"Delivered" but the agent never replied, and even restarting the session didn't
fix it. It looked dead, but it wasn't — its messages were being silently thrown
away before they ever reached it.

Here's the cause. Each running session lives in a "tmux session", and its name
is made by simplifying the topic's NAME into a slug. The trouble: there were two
Telegram topics with essentially the same name —

- #21487 "**I**nitiatives and maturation check-ins" (old, last used days ago)
- #21624 "**i**nitiatives and maturation check-ins" (your live one)

They differ only by one capital letter, so they slug to the **same** tmux name.
Two topics, one underlying session.

Now there's a safety guard whose whole job is to stop a message meant for topic A
from landing in topic B's session. When it asked "which topic does this session
belong to?", the lookup just returned the **first** one it found — the stale
21487. So when you messaged from 21624, the guard saw "this session belongs to
21487, but this message is tagged 21624 — mismatch!" and **dropped it**. Every
time. The session sat there, perfectly healthy, never hearing you.

## What already exists

- The reverse lookup `getTopicBinding(session)` that answers "which topic owns
  this session?"
- The InputGuard that compares a message's `[telegram:N]` tag to that answer and
  drops mismatches. Each part is correct on its own — the bug was only that the
  lookup couldn't handle two topics sharing one session.

## What's new

The lookup is now collision-aware. Instead of returning the first topic it finds,
it collects **all** topics that map to the session, and — because every message
carries its own `[telegram:N]` tag — it binds to the topic the message actually
names. So a message tagged 21624 now correctly resolves to 21624 and sails
through the guard, even though 21487 also shares that session.

## The safeguards in plain terms

- **No renaming, no migration.** This doesn't touch session names or rewrite any
  stored state — it just resolves the lookup more precisely at message time. So
  there's nothing to migrate and nothing to break for existing sessions.
- **Single-topic sessions are untouched.** When only one topic maps to a session
  (the normal case), behavior is identical to before.
- **Safe fallback.** If a message has no tag, or its tag names a topic that
  isn't on this session, it falls back to the old first-match behavior — never
  worse than before.
- **The guard still guards.** A genuinely cross-topic message (tag names a topic
  that does NOT share this session) is still blocked, exactly as intended.

## What you need to decide

Nothing — it ships as a normal patch with safe fallbacks. The earlier incident
was already recovered by clearing the stale topic by hand; this is the durable
fix so the collision can't silently eat messages again.
