# Dynamic MCP Lifecycle (ELI16 overview)

## The problem in one breath

Your AI session uses "MCP servers" — helper programs that give it extra tools.
The big one is Playwright, which runs a whole web browser (Chromium) so the
agent can click around websites. A browser engine is heavy: lots of memory, lots
of little processes. The agent picks which helpers to run by reading a list when
the session starts, and after that the list is frozen — you can't add or drop a
helper without restarting the session.

The catch: those heavy helpers mostly just sit there doing nothing, holding
memory and process slots. On 2026-06-26 the machine ran clean out of process
slots and the whole computer crashed. A big chunk of the wasted weight was idle
MCP helpers piled up across many sessions.

## What we're building

Three habits, so the machine only carries the helpers it's actually using:

1. **Start lean.** A new session loads only the cheap, always-needed helper (the
   little messaging bridge). The heavy browser does NOT start by default.

2. **Load it when you need it.** The moment the agent realizes mid-conversation
   that it needs the browser, it loads it. Because there's no live "add a helper"
   button, loading means: write a new helper list and quickly restart the session
   (the restart keeps the whole conversation — it's like a blink, not amnesia).
   - If the agent is **preapproved** to act on its own (an autonomous overnight
     run already is), it just does the load + restart and keeps going.
   - If it's **not preapproved**, it asks you first: "I need the browser — okay to
     do a quick restart? Your conversation is saved." and waits for your yes.

3. **Let it go when it's idle.** If the heavy browser has sat unused for a long
   while (about half an hour) under a running session, the agent drops it (another
   quick restart without it). Next time it's needed, it loads again.

## Why it's safe

It's **off by default** — nothing changes until we turn it on, and we'll dogfood
it on the development agent first. If anything goes wrong reading the helper list,
it falls back to "load everything", so a session is never left without its tools —
the safe direction is "too many tools", never "missing tools". And dropping a
helper never means reaching into a running session to kill a process: we just
restart with a shorter list, and the old browser is cleaned up the normal way
(as a leftover of the old session). That keeps our existing safety rule — "never
touch a live session's processes" — completely intact. The only time a session
restarts is when it's preapproved or when you said yes.
