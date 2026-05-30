# Codex-aware RateLimitSentinel — explained simply

## The watchdog that doesn't watch half the agents

Imagine a lifeguard whose one job is to spot a swimmer who's stopped moving and
quietly help them to the side before they panic — without yelling "YOU'RE DROWNING"
across the whole pool (which would just make things worse). That's the RateLimitSentinel.
When an AI session gets temporarily blocked by the AI provider ("you're sending too
fast, slow down"), the sentinel notices, tells the user "hang on, I'm backing off, I
haven't lost you," waits a bit, gently re-pokes the session, and checks whether it
started working again. If it never recovers, it raises a flag instead of leaving the
person stuck forever.

Here's the bug: this lifeguard only watches the swimmers wearing **blue caps** (Claude
sessions). The swimmers in **red caps** (codex sessions — like Codey) are invisible to
it. Two reasons:

1. **It can't SEE a red-cap get stuck.** The way it spots a stuck swimmer is by reading
   Claude-specific signals — Claude's process, Claude's on-screen text. Codex shows
   none of those, so a stuck codex session just... sits there, unnoticed.

2. **Even if it noticed, it can't tell if they RECOVERED.** It confirms recovery by
   watching the session's "logbook" grow (new lines = the session is working again). But
   it only knows where Claude's logbook lives. Codex keeps its logbook somewhere else
   entirely, so the lifeguard stares at an empty shelf and never sees the recovery.

The good news: the actual *rescue* move — the gentle re-poke — already works for both
cap colors (it uses a universal method). Only the "seeing" and the "confirming recovery"
are colorblind.

## The fix

Teach the lifeguard red caps too:
- **Seeing:** we already built a little meter that reads codex's own usage report (it
  literally says "rate limit reached: yes/no" and "weekly budget remaining: N%"). We
  poll that for codex sessions; if it says "limited" — or the weekly budget is nearly
  gone — we tell the sentinel "this one's stuck," exactly like the Claude signal does.
- **Confirming recovery:** we point the logbook-checker at codex's actual logbook
  location (we already have a helper that finds it). New lines there = recovered, same
  as Claude.

Crucially, we only turn on the red-cap logic for red-cap swimmers. Blue-cap (Claude)
behavior doesn't change one bit — so we can't accidentally break the part that already
works. That's why this is safer than the bigger codex parity change (the "keep going"
driver), which touches shared machinery and needs Justin's sign-off first.

## Why it matters

Codey runs on a shared, rate-limited account. When it hits a limit and freezes, right
now nothing helps it back up — it can hang forever, silently. That breaks the whole
mentorship loop. After this fix, a frozen codex session gets the same calm, automatic
"backing off, hang tight, here we go again" recovery that Claude sessions already enjoy.
