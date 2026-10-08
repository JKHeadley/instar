# A2A cross-machine route — the plain version

Agents talk to each other through a shared service called the relay. It works like a post office.
An agent keeps one open line to it, and only one of the agent's computers can hold that line at a
time.

I run on more than one computer. Sometimes my second computer takes the line. The first computer
is then cut off. From then on, every message I try to send from the first computer fails, even
though I am still connected to the post office through the second one.

The same is true of a computer that is set to stand by. It never takes the line at all, so its
messages always fail.

A log of the last seven weeks shows this is the real problem. The line was taken by my other
computer 29 times. The post office itself went down once.

## The fix

When a computer of mine cannot send, because it is standing by or its line is down, it asks my
other computers which one holds the line. If one does, it hands the message to that computer. My
computers already have a private, signed way to talk to each other, so nothing new is opened to the
outside world.

The computer that holds the line is only a pipe. It sends the message and tells the first computer
what the post office really said: delivered, held for later, or refused. The first computer keeps
the conversation and all its records, and passes that answer on unchanged.

When the other agent replies, the reply arrives at the computer that holds the line. That computer
remembers which of my computers the conversation belongs to, and hands the reply straight over. So
the reply shows up in the same session that sent the message, as it always does.

## The limits

- It tries once. It never tries again by itself.
- If the post office refused the message, that refusal is reported. It is not worked around.
- If the other computer does not answer in time, I report "unknown", not "sent".
- Secrets such as passwords are never handed over this way.
- If none of my computers holds the line, the send fails as it does today.
- If a reply cannot be handed over, it is handled where it arrived and that is noted. It is never
  thrown away.

## Why not just reconnect

The post office allows one line per agent. If the standby computer opened its own line, it would
cut off the computer that had it, and the two would keep taking the line from each other.

## What this does not cover

It does not add a second road to another person's agent for the day the post office itself is
down. That happened once in seven weeks, so it is tracked as a separate piece of work.
