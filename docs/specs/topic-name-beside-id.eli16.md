# A topic's name always travels with its id — Plain-English Overview

> The one-line version: whenever the server tells a session (or a notice tells you) about a Telegram topic, it now says the topic's name next to its number, or says plainly that the name is not known.

## The problem in one breath

The server often told an agent's session things like "the server sent it to topic 11882". The session got the number but not the name, so when it talked to its person it said "I can't see the topic name from inside this session", even though the name ("🤝 echo") was sitting in the server's own topic list the whole time. The operator's rule: an agent that has a topic's id should always have its name too; the two belong together.

## What already exists

- **The topic list** — the Telegram adapter already keeps a name for every topic it knows, and already refuses placeholder "names" such as "topic-11882".
- **The message prefix** — every Telegram message a session receives starts with `[telegram:N "topic name" from Person]`, but the name part was simply left out when it wasn't handed in.

## What this adds

One small shared helper renders a topic everywhere the server writes one: `topic 11882 "🤝 echo"`, or `topic 11882 (name unresolved)` when no trusted name exists. It looks the name up in the existing topic list itself, so callers do not have to. It never invents a name.

- The message prefix now always carries the name, looked up from the topic list when the caller did not pass one, or says `(name unresolved)`.
- The notes the server hands a session about agent-to-agent replies (which topic the person reads, where to post) name the topics.
- Attention items and other notices that mention a topic (held replies, duplicate sessions, autonomous runs, pins, working-set recovery, spend-alert routing, and so on) name it.
- A test counts every place in the code that still writes a bare `topic ${id}` and fails if a new one appears, so the rule cannot quietly erode.

## The safeguards

- A topic name is text someone typed, and it lands in a session's prompt, so it is cleaned the same way the message prefix already cleans it (no quotes, no control characters, no shouted "SYSTEM" framing) and capped in length.
- A name the registry cannot vouch for is shown as "name unresolved", never guessed.
- The prefix still starts with `[telegram:N`, so every hook and parser that reads the topic number still works.

## What you would decide

Nothing. It is on for everyone and only changes wording. The remaining bare topic numbers in the code are internal error strings; the test lists them and only lets that list shrink.
