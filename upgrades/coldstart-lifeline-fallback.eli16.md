# Cold-Start Lifeline Fallback — ELI16 overview

## The problem in plain words

When you send a message to one of your agent's topics, the agent has to *start a
session* to read and answer it. Usually that just works. But sometimes it can't
start one right then — maybe too many sessions are already running (a hard limit),
maybe the machine is low on memory or under heavy load, or maybe the startup hit an
unexpected error.

Before this change, when that happened you'd either get silence, or a bare, unhelpful
line like "Having trouble starting a session right now." Worse, one version told you
to "increase maxSessions in your config" — asking *you* to go edit a settings file.
That's backwards: the agent is the thing with the tools to free up resources and fix
the problem. You shouldn't have to.

## What this change does

Now, when the agent genuinely can't start (or restart) a session for a topic, you get
ONE clear, friendly reply that does three things:

1. **Says WHY in plain English** — "I'm already running the maximum number of sessions
   at once," or "the machine is under resource pressure right now," or an honest
   "unexpected start-up error." No jargon, no config keys.
2. **Points you to your Lifeline topic** — the one topic that's guaranteed to always be
   reachable. That's the place to go when a normal topic is stuck.
3. **Hands you a ready-to-paste message** — a pre-written line you can copy straight
   into the Lifeline that describes exactly what failed, so the agent can diagnose and
   free resources fast. You don't have to explain anything yourself.

If the failing topic *is* your Lifeline, it doesn't tell you to go elsewhere — it says
you're already in the right place and it'll start freeing resources. If you have no
Lifeline configured, it still tells you why and reassures you that your message isn't
lost — just resend once things settle.

## Why it's built this way

This is the "G1" half of a constitutional standard called **"The Agent Is Always
Reachable."** The core idea: the agent must never go silently unreachable, because the
agent itself is the solution — it holds the tools to diagnose and free resources, so it
has to stay reachable to use them. The reply is sent on a *deterministic* delivery path
(a direct send), never through the smart message-review gate, because that gate could
itself fail under the very resource pressure we're trying to report.

It's an always-on safety floor with no on/off switch — the standard forbids hiding
reachability behind a flag. Under the hood it's a small, well-tested message builder
wired into the two places a session-start can fail (a fresh spawn and a restart), plus
a CLAUDE.md note so any agent can explain "why did I get a go-to-lifeline message?" if
you ask.
