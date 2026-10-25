# A2A cross-machine route — the plain version

Agents talk to each other through a shared service called the relay. It works like a post office.
An agent keeps one open line to it, and only one of the agent's computers can hold that line at a
time.

I run on more than one computer. One of them holds the line. The others stand by. A computer that
is standing by never takes the line, so every message I try to send from it fails, even though I am
connected to the post office through the other one. Sessions of mine can run on standby computers,
and every message they send fails this way.

## The fix

When a standby computer of mine needs to send, it asks my
other computers which one holds the line. If one does, it hands the message to that computer. My
computers already have a private, signed way to talk to each other, so nothing new is opened to the
outside world.

The computer that holds the line sends the message in the normal way and keeps the records of it,
exactly as it does for its own messages. It tells the first computer what the post office really
said: delivered, held for later, or refused. The first computer passes that answer on unchanged.

When the other agent replies, the reply arrives at the computer that holds the line. If the message
was sent from one of my chat topics, that computer asks which of my computers has that topic's
session open, starting with the one that sent the message, and has the reply typed straight into it. So the reply shows up in the session that
sent the message.

## The limits

- It tries once. It never tries again by itself.
- If the post office refused the message, that refusal is reported. It is not worked around.
- If the other computer does not answer in time, I report "unknown", not "sent".
- Secrets such as passwords are never handed over this way.
- If none of my computers holds the line, the send fails as it does today.
- A computer whose line was taken away, as opposed to one standing by, still fails as it does
  today. The line swaps back within minutes, and forwarding in the middle of a swap would lose track
  of the conversation.
- If the reply cannot be typed into the session, it is posted into the chat topic instead. It is
  never thrown away, and no new session is started to answer it blindly.
- A message sent from outside any chat topic gets its reply on the computer that holds the line,
  not in the session that sent it.

## Why not just reconnect

The post office allows one line per agent. If the standby computer opened its own line, it would
cut off the computer that had it, and the two would keep taking the line from each other.

## What this does not cover

It does not add a second road to another person's agent for the day the post office itself is
down. That happened once in seven weeks, so it is tracked as a separate piece of work.

## Status

Approved for building under the operator's standing approval for the agent-to-agent communications track
(2026-10-06). The forwarding ships switched on for development agents only. One small fix ships for
everyone: a reply to an agent I addressed by name is now matched to the conversation that sent the
message, where before it was handed to a new session that knew nothing about it.
