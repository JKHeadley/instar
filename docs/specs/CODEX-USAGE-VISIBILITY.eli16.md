# Plain-English overview: checking codex usage over HTTP

## What this is

Some instar agents run on "codex" (OpenAI's coding CLI) instead of Claude.
Codex accounts have usage limits — a 5-hour window and a weekly window — and
when you run out, codex just starts failing. Today, the only way to see how much
you have left is to open codex's interactive status screen and read it with your
eyes. An agent can't do that. So a codex agent has no idea it's about to hit a
wall, and a supervising agent can't see it coming either.

## The trick

It turns out codex already writes down those exact limit numbers. Every time it
finishes a turn, it saves a little record to a log file on disk that includes
"5-hour window: 13% used" and "weekly window: 93% used," plus when each one
resets. We checked a real log against the live status screen and the numbers
matched. So the data is already there — nobody was reading it.

## What's new

We added a small reader that finds the most recent codex log, reads just the
tail end of it (where the freshest numbers are), and pulls out the usage. Then
we added one web address on the agent's own server — `GET /codex/usage` — that
returns those numbers as clean JSON: percent used and remaining on each window,
when they reset, which model is running, and whether either window is maxed out.

## What already existed

Codex agents already had a separate token-counter, but it self-admits it's not
authoritative — it only adds up tokens locally and can't see the real account
limits. This new reader uses the *real* limits codex got back from OpenAI, which
is the number that actually matters.

## Safeguards

This change only *reads*. It never changes a codex session, never blocks
anything, and never makes a decision. If there's no codex data on disk (for
example, a pure-Claude agent), the endpoint politely says "available: false" and
still returns a normal 200 response instead of an error. It needs the normal
login token like every other endpoint, and you can only read from it — there's
no way to write through it.

## What you need to decide

Nothing risky. This is a pure add-on: a new read-only endpoint, plus a note in
the agent's instructions so it knows the endpoint exists. If it were ever
unwanted, removing it is clean — there's no data to migrate and no state to
repair. The main thing to confirm is that surfacing account usage this way is
fine (it is the same information the codex status screen already shows the
account owner).

## What comes next

This is the first half of a pair. The second half — a separate change — will
*use* this signal to automatically switch codex to a backup model with its own
quota when the weekly window is nearly empty. This change just makes the number
visible; it does not act on it.
