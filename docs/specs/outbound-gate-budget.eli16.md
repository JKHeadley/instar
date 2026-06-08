# Outbound Gate Budget — Plain-English Overview

> The one-line version: the quality checkpoint every outgoing message passes through could get stuck for 2–3 minutes under load and miss the delivery deadline, so we give it a short fixed deadline and let messages through if it can't decide in time.

## The problem in one breath

Imagine every message your agent sends has to pass one checkpoint that asks "is this relevant and well-written?" before it leaves. Normally that takes a couple of seconds. But when the AI service is overloaded, the checkpoint can get stuck waiting in line for two to three minutes — and the delivery truck only holds the door for two minutes before giving up. So the message got stranded at the checkpoint, the send "failed," and the agent shoved the announcement into whatever chat it happened to be in. That's exactly why update notes kept landing in the wrong topic.

## What already exists

- **The outbound checkpoint (the tone/relevance gate)** — every reply, attention item, and update post runs through it. It is *designed* to wave a message through if it can't decide quickly (it "fails open"), so it never silently swallows a real message.
- **The delivery deadline** — outbound routes are allowed 120 seconds total; after that the request times out and reports failure.
- **A faster sibling check (ArcCheck)** — already guards itself with a tiny 200ms deadline so a slow version of it can never stall the message. The fix copies that proven pattern.

## What this adds

We give the checkpoint its own short, fixed deadline (20 seconds) that is safely shorter than the 120-second delivery deadline. If the checkpoint answers in time, its decision is used exactly as before — including blocking a genuinely bad message. If it can't answer in 20 seconds, the message is waved through (delivered) instead of being held until the delivery truck leaves. Because the deadline lives at the route, this works no matter how the underlying AI service behaves — a future change to it can't bring the stall back.

## The new pieces

- **`reviewWithinBudget`** — a tiny helper that runs the checkpoint against a stopwatch. It is NOT allowed to change the checkpoint's actual verdict; it only decides "did the checkpoint answer before the stopwatch ran out?" If yes, use the real answer; if no, deliver the message and note that it timed out.
- **`OUTBOUND_GATE_REVIEW_BUDGET_MS`** — the 20-second stopwatch value, kept right next to the 120-second delivery deadline so the two can never drift into conflict (a test enforces that the stopwatch is always shorter).

## The safeguards

- Real blocks still block — a message the checkpoint rejects in time is still rejected (a test proves a bad "Gemini is fully ready!" message still gets stopped).
- Failing open faster is strictly safer than today: a timeout used to mean the message went unreviewed AND landed in the wrong chat; now it just means a fast, in-the-right-place delivery.
- Existing agents get the fix automatically on update — the deadline lives in code, so there's nothing for anyone to configure. An optional knob exists for operators who want to tune it.
- This does NOT fix the separate habit of an agent re-posting a failed update into a working chat; it removes the cause (the stall) so that rarely happens, and the habit is tracked as a follow-up.
