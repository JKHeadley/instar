# Lifeline replay: stop dropping real messages — Plain-English Overview

> The one-line version: when the server is slow or restarting, a user's message must wait in line and be retried — never be thrown away as if it were a bad message.

## The problem in one breath

When my server gets overloaded (the recent macOS CPU pileup), the piece that catches your Telegram messages while the server is busy ("the lifeline") would try to hand a message over, time out a few times in ~90 seconds, and then **throw the message away** — treating "the server is too busy right now" exactly like "this message is broken." On top of that, the waiting line emptied itself to disk *before* confirming delivery, so a restart at the wrong moment could lose a message with no record at all. That combination is why a real question vanished and a later "checking in" got an unrelated reply.

## What already exists

- **The lifeline** — a small always-on process that receives your Telegram messages and forwards them to the main server. If the server is down, it parks the message in a queue and retries later.
- **The drop log** — when the lifeline finally gives up on a message it writes a record and tries to tell you "I lost that, please resend."
- **The retry budget** — each message got 3 tries before being dropped.

## What this adds

The lifeline now tells two very different failures apart. A **bad message** (the server looks at it and says "no, this is malformed" — an HTTP 400) is the only thing that can use up the 3-try drop budget. A **busy/slow/restarting server** (a timeout, a 5xx, a dropped connection) no longer counts against that budget at all — the message simply stays in line and is retried when the server recovers. A separate, very generous safety limit still stops the queue from growing forever if a server is broken for hours.

## The new pieces

- **A small decision module (`decideReplay`)** — given the result of one delivery attempt, it returns one of: delivered, keep-in-line-and-retry, or drop. It is pure logic with no side effects, so it is easy to test exhaustively. Its whole job is to make sure only a genuinely bad message can ever be dropped.
- **A durable waiting line** — a message now leaves the queue only *after* it is actually delivered (or deliberately dropped). A restart in the middle of catching up can no longer lose anything; the leftovers are still on disk for the next try.

## The safeguards

**Prevents a busy server from eating your messages.** Timeouts and server-busy errors never burn the drop budget, so an overloaded box just delays delivery instead of discarding it.

**Prevents silent, trace-less loss.** Because the queue keeps a message until delivery is confirmed, a mid-restart crash leaves the message safely on disk instead of vanishing.

**Prevents an infinite backlog.** If a server is genuinely unreachable for a very long time (hundreds of attempts), the message is finally dropped *with* an honest record and a resend notice — never silently.

## What ships when

One change, one PR: the classification + the durable queue land together, behind comprehensive tests. No config to flip, no migration — existing queued messages keep working.

## What you actually need to decide

Whether to ship this fix now on your existing approval, or run it through the heavier multi-reviewer spec process first for extra rigor.
