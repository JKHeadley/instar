# Honest Session-State Surfaces — Plain-English Overview

> The one-line version: when one of my sessions goes quiet, I sometimes tell you "it's actively working" or "a restart is queued" — even when that's not true. This fixes the two cases where I say something comforting that isn't real.

## The problem in one breath

I have two background helpers that talk to you when a session goes silent. Both of them currently fib in specific situations:

1. The **standby helper** ("🔭 working on it…") says "actively working" for the first few minutes — even when the session is actually rate-limited, stuck on a policy error, or out of room to think. It only tells the truth later, at the 5-minute mark.
2. The **reap helper** ("your session was shut down…") sometimes promises "A restart is queued, I'll bring it back" — even when the restart queue is *paused* and won't bring anything back until it's un-paused. That's a promise I can't keep right now.

## Fix 1 — the standby helper tells the truth sooner

I already have an honest "why is this session stuck?" detector. It knows the difference between rate-limited (will fix itself), policy-wedged / thinking-error / too-long-conversation (needs a fresh start). The catch: I only used it at the **5-minute** check. At the **0-minute** and **2-minute** checks I just said "actively working" no matter what.

This change moves that honest detector earlier, so the first thing you hear about a genuinely-stuck session is the real reason — not a false "working".

Important guardrails:
- If the session is genuinely working (just quiet), nothing changes — you still get the normal "working" message.
- If another part of me is already handling the stuck session and talking to you about it, the standby stays silent so you hear **one voice**, not two.
- It only ever changes the *words* of a message. It never blocks, delays, or restarts anything.
- It ships **dark on the real fleet** and **live only on my development self** first, because it changes wording you actually see — so I dogfood it before anyone else gets it.

## Fix 2 — don't promise a restart the paused queue won't deliver

The restart queue can be **paused** (for example, by an emergency stop). When it's paused, queued work sits and waits — it does not come back until the queue resumes. But the "is a restart queued?" check forgot to look at the paused flag, so it still answered "yes" — and you got told "I'll bring it back" when I wouldn't, not until the pause lifted.

The fix is a one-line correctness change: while the queue is paused, the "is a restart queued?" check answers "no", so you don't get a promise I can't keep right now. Your work isn't lost — the queued entry is still there and comes back the moment the queue resumes. I just stop *claiming* it's coming back while it's frozen. No flag needed; there's no version of this where lying is the right answer.

## Why this is safe

- **Both fixes only change what I SAY, never what I DO.** No session is restarted, killed, or recovered differently. The restart queue still works exactly the same — I just stop over-promising while it's paused.
- **Fix 1 is off by default everywhere except my dev self.** With the flag off, the standby wording is byte-for-byte what it is today.
- **Both are per-machine.** The standby reads the live terminal of a session running on this same machine; the restart queue is this machine's own queue. Nothing crosses between machines.

## What you might notice

Once Fix 1 graduates to the fleet: if a session is rate-limited or stuck, you'll hear the real reason within the first minute or two ("I've hit the usage limit, resets at…" / "the session got wedged — resend your last message") instead of a falsely-reassuring "actively working." And you'll never again be told "a restart is queued, I'll bring it back" while the queue is actually paused.

## Explicitly NOT in this change

The split-brain "should I demote the other machine?" decision is a separate, operator-facing item and is **not** touched here.
