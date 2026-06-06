# ELI16 — Remembering the boss on the simpler phone line too

## The one-sentence version
The agent now writes down "this is the verified boss of this chat" no matter
which of its two message pipes the boss's message arrived through — before, one
pipe did this and the other forgot.

## The backstory
We've been closing a real security hole: an agent on a shared computer slowly
started treating a *different real person* (call her Caroline) as its boss. The
fix was a filing cabinet that records, per chat, who the verified boss is —
decided ONLY by the verified ID of whoever actually sent the message, never by a
name typed in a document. The last step (increment 2d) made the cabinet fill in
automatically — but only on the agent's MAIN message pipe (the relay most of the
fleet uses). A simpler setup, where the agent talks to Telegram directly without
the relay, still never filled in the cabinet. That was safe (an empty cabinet
just means "I don't know," never a wrong answer), but it meant some agents never
learned who their boss was.

## What this change adds
Both pipes eventually flow through one shared doorway in the code (the
`onTopicMessage` seam). This change puts the "write down the boss" step at that
doorway, so it runs no matter which pipe delivered the message. Two careful
details:

1. **The doorway still checks the allowed list.** The main pipe lets messages
   from non-allowed people *through the doorway* (it just refuses to bind them
   earlier) — so the doorway check is load-bearing. Without it, an outsider in
   the group could seat themselves as boss — the exact Caroline bug. We test
   this with a literal unauthorized "Caroline" message and prove nobody gets
   written down.
2. **One cabinet, not two.** The cabinet keeps a copy of its contents in memory.
   If the doorway opened its OWN second cabinet on the same file, the two copies
   could silently overwrite each other's entries. So the doorway asks the server
   for its existing cabinet (resolved late, because the server is built after
   the doorway is wired) — same instance, no lost entries. A test proves an
   entry written one way survives an entry written the other way.

## A small bonus fix
Since both pipes now re-write the boss on every message, the cabinet learned to
notice "this is exactly what I already have" and skip the disk write — a
re-delivered or repeated message is now a pure read instead of a pointless file
rewrite.

## Why it's safe
- Wrapped so any failure is logged and swallowed — recording the boss can never
  break message handling.
- Before the server finishes booting, the doorway just skips the step (no
  cabinet yet = nothing written = fail-safe).
- On the main pipe both the old write (increment 2d) and the new doorway write
  run — same cabinet, same record, harmless.

## What's deliberately left for next time
Nothing in this family — the operator-binding loop is now closed on every
ingress path. The remaining Know Your Principal work is elsewhere (per-agent
credential isolation, Phase 3).
