# Lifeline "reconnecting" notice — Plain-English Overview

> The one-line version: when my server is healthy but a single message hand-off hiccups, I now tell you "I'm reconnecting, your message is queued" instead of the false, alarming "Server is restarting."

## The problem in one breath

The lifeline is the small always-on process that watches Telegram and hands your messages to my main server. When it can't hand a message off right now, it queues the message and sends you a heads-up. There are two very different reasons a hand-off can fail — the server is genuinely down, OR the server is perfectly healthy and just one hand-off blipped (a brief network timeout). The old code sent the SAME scary "Server is restarting. Your message has been queued…" text for BOTH cases. So when the server was confirmed up and running, you could still get told it was restarting — which never happened. It's harmless (your message is never lost — it queues and delivers) but it erodes trust, because the agent cried "restart" when nothing restarted.

## What already exists

- **The lifeline** — the tiny watchdog process that forwards your Telegram messages to the server and queues them if it can't. Already durable: queued messages survive and replay.
- **The server health check** — the lifeline always knows whether the server is up (`supervisor.healthy`). That verdict was already available at the exact spot where the wrong message was sent; the code just wasn't using it to pick the right words.
- **The genuinely-down message** — for a truly-down server the lifeline already said the accurate "Server is temporarily down…", and that wording is unchanged.

## What this adds

One small, tested helper (`buildQueuedNotice`) now decides the notice wording from the live health verdict. When the server is healthy but the hand-off failed, you get: "I'm having trouble reaching my server right now — your message is queued (N in queue) and I'll deliver it as soon as I reconnect." When the server is genuinely down, you get the exact same accurate "temporarily down" message as before. The three places that send this notice (text, photo, file) all route through the one helper, so they can never drift apart again.

## The new pieces

- **`buildQueuedNotice(kind, queueLength, serverHealthy)`** — a pure, side-effect-free function that returns the right notice text. It is NOT allowed to make any decision about delivery or restarts; it only chooses words from a health verdict it is handed. That line matters: the authority to restart still lives entirely in the existing restart machinery — this helper just describes the current state honestly.

## The safeguards

The genuinely-down wording is byte-for-byte identical to before (a test locks that in, so no downstream dedup behavior shifts). A unit test proves the healthy-but-failed branch never contains the words "restart" or "temporarily down", and always mentions "reconnect"; and that the two states always produce different text. Scope is deliberately tight: the drift-promoter threshold question and the callback-query down-message are explicitly out of scope and were left untouched.

## What you actually need to decide

Nothing risky. This is a wording/logic bug fix with no new capability, no config, no state, and no schema change. The only judgment call is the exact replacement wording, which reads in plain language and is honest about what's happening. If it turns out wrong, the back-out is a one-line revert.
