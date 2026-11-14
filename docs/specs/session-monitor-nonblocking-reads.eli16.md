# The session health check stops making the server wait — Plain-English Overview

> The one-line version: once a minute the server checks every open conversation's terminal, and it used to stand still while each check ran; now it asks and carries on, picking up each answer when it arrives.

## The problem in one breath

Each conversation with the agent runs in its own terminal session, managed by a program called tmux. Once a minute a part of the server called the session monitor looks at every one of them: is it still alive, and what is on its screen? That tells it whether a conversation has died or stopped responding, so it can restart it or let the person know. Each of those questions is a small helper program, three per conversation, and the server waited for each one before doing anything else. The server does everything on one main thread, so while it waits it can answer nothing. On a quiet machine that is about 12 milliseconds per conversation. On a machine saturated by a test run each helper can take seconds, and on 2026-11-13 these waits were among the largest in a profile of a server that kept being killed for not answering.

## What already exists

- **The session monitor** — decides whether a conversation is healthy, idle, unresponsive or dead, and starts recovery or tells the person. Its rules are not changed.
- **Waiting versions of the two questions** — "is it alive" and "what is on its screen", each of which holds the server until tmux answers.
- **Non-waiting versions of the same two questions** — already built and tested for other parts of the server (the "async hot path"), switched on for development agents and off for everyone else. They ask tmux the same things and let the server carry on meanwhile.

## What this adds

The session monitor's once-a-minute check now uses the non-waiting versions where they are switched on. The non-waiting path already existed and is tested; it gets one more user, two repairs (below), and a small report for when tmux stops answering.

## The new pieces

- **Two optional inputs to the monitor** — the non-waiting "is it alive" and "what is on its screen". When both are given, the minute check uses them. When they are not (the switch is off), the monitor behaves exactly as before.
- **"Don't know" counts as alive** — the non-waiting check can answer "tmux did not reply in time". The monitor treats that as alive and looks again a minute later.

## The safeguards

**A slow tmux is no longer mistaken for a dead conversation.** The waiting check gave up after 5 seconds and reported the conversation dead, which could start a restart of a conversation that was fine. The non-waiting check says "don't know", and the monitor leaves the conversation alone. A conversation tmux says is gone is reported as gone by both, and is handled exactly as before. The one difference is while tmux itself is not answering: then the monitor waits, where before it would have guessed "dead".

**A tmux that has stopped answering is noticed.** If a conversation gets "don't know" five checks in a row, the server says so once in its log. And if a whole round of checks takes longer than a minute, the next round is skipped and that is logged too, so a monitor that has gone quiet never looks the same as one with nothing to report.

**Two repairs to the shared non-waiting path.** A reviewer found that the non-waiting check answered "don't know" forever when tmux was not running at all after a restart of the machine, where the right answer is "gone"; and that two parts of the server asking for the same screen at different lengths could be handed each other's answer. Both are fixed here and tested. The second helps every user of that path; the first helps the parts that ask through the same function (the cleanup of finished sessions, for one), but not the start-up cleanup, which asks tmux a different way and is left as it is.

**Same decisions otherwise.** Tests run the same situations through both versions (a dead conversation, an unanswered message on a silent one, new activity on screen) and require the same outcome. One small exception: when a conversation's terminal has ended in a way that does not say whether it finished, the non-waiting check does not read its screen that minute, where the waiting one did.

**Same switch, same reach.** This rides on the existing "async hot path" setting: on for development agents, off elsewhere. Turning that setting off returns the monitor to the waiting versions.

## What is not fixed by this

Inside the rare decision "should I really tell this person their conversation died", the monitor still double-checks with the waiting version. That happens only when a conversation looks dead, not every minute for every conversation. The monitor also still reads the last few messages of each conversation from a file every minute; that is a file read, not a helper program, and is not changed here. Other once-a-minute tmux users are tracked under the same commitment (CMT-1718).

## What you actually need to decide

Nothing. This is a small, reversible change: no stored data or setting changes, and a revert restores the old behaviour.
