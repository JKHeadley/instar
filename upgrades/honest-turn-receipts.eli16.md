# ELI16 — Honest Turn-Receipts

## The problem

Three times in two days, the same thing happened: you sent me a message, you
saw "✓ Delivered" and "🔭 actively working" — and then nothing. No reply. You
found out by screenshot each time. Three different reasons underneath (I'd hit
the usage limit, or my session got stuck on a content-policy error, or the
conversation ran out of room), but ONE misleading symptom: the system kept
telling you I was "actively working" when I was actually dead in the water.

Why did it lie? Because the way it checked "is this session working?" was "is
its program still running?" — and a stuck session's program IS still running.
It's alive, it's even printing stuff to the screen; it just can't answer. So
the live program fooled the check into saying "working."

You also noticed a related annoyance: "conversation too long" messages popping
up often even when the conversation was fine. Same kind of bug — the system was
finding that phrase ANYWHERE on the screen, including an old one from an hour
ago that had already been dealt with and scrolled up out of the way.

## What this fixes

Now, before the system says "working," it reads the bottom of the screen — the
LIVE part, what's happening right now — and checks for the known "alive but
can't reply" situations. If it finds one, it tells you the truth instead:

- "I've hit the usage limit (resets 10:30pm) — I'll pick back up automatically,
  your messages aren't lost."
- "My session got stuck on a content-policy error — please resend your last
  message."
- "This conversation got too long — I'm starting fresh, resend your last one."

And the "conversation too long" noise is gone: it only fires if that's what's
ACTUALLY happening right now at the bottom of the screen, not an old mention
that scrolled by.

## Two safety rules

1. **It only reads — it doesn't act.** Fixing the stuck session is still the
   job of the recovery system. This part just stops lying about what's wrong.
2. **One voice.** If the recovery system is already telling you about a stuck
   session, this stays quiet so you don't get two messages about the same thing.

Tested with the exact text from the real screenshots you sent — 30+ new checks
covering both "say the honest thing when stuck" and "stay quiet when fine,"
plus all 119 existing standby checks still pass.
