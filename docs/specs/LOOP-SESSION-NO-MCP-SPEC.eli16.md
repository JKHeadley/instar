# In plain English: stop the mentor loop's helper session from hanging on startup

## What this is about

The mentor "autonomous-fix loop" works by starting up a fresh AI session (a copy
of Echo) every cycle to do real work — check on the other agent, fix bugs, ship
the fix. That fresh session is started in the background, headless, with no
human watching.

## What went wrong

When you start an AI session in this project, it normally loads a bunch of extra
"tools" called MCP servers — things that let it use Fathom, a browser, and so on.
Some of those tools need you to log in (an OAuth pop-up) the first time. But a
headless background session has no screen and no human to click "approve" — so
those login-required tools just sit there waiting forever, and the whole session
gets stuck before it even starts doing its job.

We saw this live: the first real loop session sat for four and a half minutes
using almost no CPU, produced nothing, and never started its task. The startup
was correct in every other way (right model, right instructions) — it was purely
the tool-loading that jammed it.

## What's new

The loop session now starts with NO MCP tools at all. The AI command has a switch
for this — basically "ignore the project's tool list and start with an empty one."
The loop doesn't need any of those tools anyway: it talks to the other agent over
Telegram and ships fixes using the built-in file and command tools. With the
switch on, a session that used to hang for minutes now starts in about nine
seconds.

The switch is opt-in: only the loop session uses it. Every other kind of session
in the system keeps all its tools exactly as before — nothing else changes.

## What the reader needs to decide

Nothing to configure. This is a reliability fix for the (off-by-default) mentor
autonomous-fix loop, found by actually running it. A unit test checks the right
switches are produced, and the end-to-end test proves the real startup path turns
the switch on. The proof it works is the re-run: the loop session now boots and
does its cycle instead of hanging.
