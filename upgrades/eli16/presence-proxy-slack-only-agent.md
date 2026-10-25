# ELI16 — The watcher that notices you were ignored should exist on Slack too

## The one-sentence version

The whole mechanism that notices "you sent a message and nobody answered" was
only ever built on agents that have Telegram — and its Slack support was written
inside that same Telegram-only wrapper, so an agent that talks on Slack got none
of it.

## What the watcher does

When you write to an agent and no real reply comes back within a tier of time, a
watcher speaks up: it tells you what the session is actually doing, offers the
commands to unstick it, and escalates if it stays silent. It is the thing standing
between you and an agent that has quietly stopped answering.

## The gate

That watcher, the Slack code that feeds it, the Slack commands you would use to
unstick it, and the promise-follow-through beacon were all created inside one
conditional: *if this agent has a Telegram adapter*.

Its Slack support sat inside the same wrapper. So on a Slack-only agent the
condition was false, nothing inside ran, and the watcher did not exist at all —
not misconfigured, not disabled, simply never built. The proof is blunt: the
indra agent's entire log history contains no line saying the watcher was wired to
Slack, because that line is inside the block that never ran.

That is why an operator message to indra could sit unanswered for twenty-eight
minutes with nothing raised anywhere.

## Why the fix is small

Everything the watcher is handed already knew about Slack. Each piece of
information it asks for — which session serves this conversation, has the agent
replied since, is a recovery already in progress — looks up the Slack
conversation first and only falls back to Telegram. The Slack half was finished
work waiting behind a door.

So the change is the door: admit an agent that has Slack *or* Telegram. Then make
sure nothing inside assumes Telegram exists — the message-capture chains that are
genuinely Telegram-only are skipped rather than crashing, and the Telegram
fallbacks return "no session" instead of asserting that Telegram is there.

## The part a compiler cannot check

Three of those fallbacks used an assertion that silences the compiler and crashes
at run time instead. The compiler was happy; a Slack-only agent would have died at
startup. They are gone, and a test now checks the block contains none — because
"it compiles" and "it runs" are different claims.
