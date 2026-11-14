# The resume check asks tmux once, not once per conversation — Plain-English Overview

> The one-line version: once a minute the server asked a helper program about each open conversation separately, waiting for each answer; now it asks one question that covers all of them.

## The problem in one breath

Each conversation with the agent runs in its own terminal session, managed by a program called tmux. Once a minute the server refreshes its note of which saved conversation belongs to which topic, so that a conversation can be picked up again after a restart. Before it does, it checks that each session's terminal is really alive. It did that by starting tmux once per session and waiting for each answer before doing anything else: about 40 small programs in a row on the Studio. The server does everything on one main thread, so while it waits it can answer nothing. On a quiet machine the 40 waits add up to about a sixth of a second. On a machine saturated by a test run, each one can take seconds, and they were the largest single source of such waits in a profile taken on 2026-11-13, a night on which the server was killed several times for not answering.

## What already exists

- **The resume map** — a small file that says, for each topic, which saved conversation to resume. This change does not alter what goes into it.
- **The liveness rule** — a session counts only if its terminal pane exists and its program has not exited. This rule is unchanged.
- **The once-a-minute refresh** — unchanged in timing.

## What this adds

One question to tmux, "list every session with its pane and whether the pane is dead", in place of one question per session. The server then looks each session up in that one answer.

## The new pieces

- **One list read** — a single tmux call that returns a line per session: its name, its pane, and whether the pane is dead.
- **Exact name matching** — a session is found only by its full name, so a session called "topic" is never mistaken for "topic-long".

## The safeguards

**Same answer as before.** On the Studio's 41 live sessions the one list and the 41 separate questions gave identical results, line for line. On a second comparison 40 sessions, 4 of them with a dead pane, also matched. Tests cover a live pane, a dead pane, a session missing from the list, a line with no pane, lines that cannot be read, and names that are prefixes of each other.

**The answer is readable wherever the server runs.** tmux quietly replaces some separator characters when it is started without the usual language settings, which would have made every session look dead. The list uses a separator tmux never replaces, a test runs the real tmux with those settings stripped, and if the answer ever comes back unreadable the server says so in its log.

**A failed read changes nothing.** If tmux cannot answer (it is not running, or it is too slow), the refresh treats no session as live for that minute and writes nothing. Every existing note is kept. A failed question about a single session did the same before.

**Held to one call.** A test counts the calls: 44 sessions, one call.

## What is not fixed by this

The one remaining call is still made on the main thread, and other once-a-minute checks still ask tmux about sessions one at a time (the session monitor is the next largest). Those are tracked under the same commitment (CMT-1718).

## What you actually need to decide

Nothing. This is a small, reversible change: no stored data or setting changes, and a revert restores the old behaviour.
