# A Reply Into a Sleeping Topic Wakes It — Plain-English Overview

> The one-line version: when another agent replies to a conversation that belongs to one of my Telegram topics, and that topic's session has been shut down for being idle, the reply now wakes the session up instead of disappearing — and the other agent is only told "reply coming" once something actually received the message.

## The problem in one breath

Agents talk to each other over Threadline. When I start a thread from a Telegram topic, replies on that thread are routed back into that topic's session. Sessions that sit idle get shut down ("reaped") to save resources. On 2026-10-11 Dawn sent me four replies between 21:37 and 04:39 UTC on a thread whose topic session had been reaped. For each one: my server immediately told Dawn "Message received. Composing response...", then the routing code saw the topic's session was not running, marked the reply as "resume pending" and did nothing else. Nothing ever started the session, nothing replayed the reply, and the log even said "Resumed session". All four replies were lost until a user message happened to restart the topic.

## What already exists

- **The topic respawn path.** When a user sends a Telegram message to a topic whose session died, the server respawns that session, resuming its earlier conversation, with the message as its first input. It has a per-topic guard so two respawns never race, and it can wait until the message has really been typed in.
- **The topic-linkage handler.** It decides how a reply on a topic-bound thread is handed over: typed into the live session, or posted in the topic as a visible notice when that fails.
- **The automatic ack.** Every real inbound message gets a short "Message received" reply so the sender knows it arrived.

## What this changes

- **Wake instead of wait.** If the topic's session is not running, the reply now goes through the same respawn path a Telegram message uses, with the reply as the first thing the woken session reads. If the respawn is refused (another machine owns the topic, or a respawn is already under way) or fails, the reply is posted in the topic so it is never silent.
- **Honest reporting.** The router only says "resumed" when a session actually received the reply. An accepted-but-undelivered message is logged as exactly that.
- **No false promise.** For replies on topic-bound threads, the "Composing response..." ack is held until routing finishes, and is sent only if a live session got the message.

## Safeguards

A live session is still typed into and never respawned. The respawn makes the same checks a Telegram message would: it never runs for a topic another of my machines owns or when this machine should hand the work to the machine holding the serving lease; it does not restart a session that died from hitting a usage limit; it starts fresh if the old conversation had grown too long; and only one respawn per topic can run at a time. Nothing new is configurable; the change only affects the case that used to lose messages.

## What you need to decide

Nothing. This is a bug fix that restores the behaviour the system was already meant to have.
