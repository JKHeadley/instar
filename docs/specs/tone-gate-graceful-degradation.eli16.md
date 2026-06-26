# Tone-Gate Graceful Degradation — Plain-English Overview

## What broke

Before any reply I send you on Telegram goes out, it passes a quick "tone check"
— a small AI review that catches things I should never send (a leaked password, a
file path, a raw command, an internal code name). That check is good. But it had
one blunt rule: **if the AI doing the check wasn't reachable, hold EVERY message.**

Tonight that rule backfired. The engine running the check got rate-limited and its
safety switch flipped off. With the checker unreachable, the gate held every single
reply I tried to send you — for hours. You saw "delivered" receipts but never got a
reply. The safety mechanism became the outage.

## What this change does

It makes the gate degrade gracefully instead of going dark. When the AI checker is
unreachable, the gate now falls back to a **fast, built-in, no-AI safety scan** that
runs right inside the program (no network, no extra processes, so it works even when
everything else is overloaded). That scan looks for the genuinely dangerous stuff —
leaked commands, file paths, secrets, internal code names.

- If your reply is **clean** by that scan → it **sends**. You hear from me even
  during an outage.
- If your reply actually **contains a leak** → it's still **held**. The dangerous
  class never escapes, outage or not.

## What already existed vs. what's new

- **Already existed:** the AI tone check, the built-in leak detectors it uses, and a
  config switch (`failClosedOnExhaustion`) to make the gate stricter or looser.
- **New:** the gate now uses those same built-in leak detectors as a fallback when
  the AI checker is down, instead of just freezing. One new internal flag marks a
  message that went out via this fallback (for the logs).

## The safeguards, in plain terms

- A real leak is **never** sent on the fallback path — only messages the fast scan
  clears go through.
- The "host is overloaded" case (a different, brief, self-recovering condition) is
  left exactly as it was: it still holds and retries. Only the *sustained* outage
  case — the one that cut you off tonight — changed.
- The tone/style judgments (is this too jargony, am I quitting on myself) aren't
  checked during an outage, because those genuinely need the AI. A slightly-off
  message reaching you beats silence; a leak does not. Full checking resumes the
  moment the AI checker is back.

## What you'd actually decide

This is on by default because silence is the worse failure. If you ever want the old
strict behavior back — hold everything when the checker is down, even clean messages
— there's a one-line config switch (`failClosedOnExhaustion: true`) that restores it
with no restart. That's the only knob; everything else is automatic.
