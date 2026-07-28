# ELI16 — Make load-balancing actually work (pin sessions to a pool account)

## The plain-English version

You have five Claude accounts in a pool, and you turned on "auto-swap" — the idea that when one account hits its weekly limit, the agent moves its work onto a fresh account instead of getting stuck. But it didn't work: a session hit its limit and just died. This change is the missing piece that makes auto-swap actually do its job.

## Why auto-swap was secretly broken

Auto-swap works like this: when a session gets rate-limited, it asks "which account is this session running on?" so it can move it to a *different* one. The problem: it asked, and the answer was always "I don't know." Why? Because the agent's sessions don't actually launch on a *chosen* pool account — they launch on the computer's default Claude login, with no record of which account that even is. So every session was an untagged orphan, and auto-swap, finding no account to move *from*, silently gave up. We verified it: zero of sixty running sessions carried an account tag.

So "auto-swap is on" was a comforting label on a switch wired to nothing.

## What this change does

Two things, both at the moment a session is created:

1. **Launch it on a chosen account.** Instead of the murky default login, a new session launches on a specific pool account picked by the scheduler — the one with the most room left and the soonest reset (so we drain quota before it's wasted). It does this by setting the account's "config home" for that session.
2. **Tag it.** The session records which account it's on. Now when it hits a wall, auto-swap can read that tag and move it to a fresh account.

Together, that's the link that was missing. With it, the chain finally connects: pick an account → run on it → tag it → swap it when it walls.

## Why it's safe

This touches the most sensitive code in the system — how every session is started — so it's built to be a complete no-op by default. There's a switch (`pinSessionsToPool`) that's OFF unless you turn it on. While it's off, sessions launch exactly as they always have: no account override, no tag, byte-for-byte the old behavior. Only when you flip it on does the new path kick in, and even then it only ever runs for Claude sessions (not Codex/Gemini), and if no account is available it quietly falls back to the default. So the risk surface is gated behind a switch you control.

## What you'll do with it

Once this ships, you turn the switch on and set the agent's account to one with headroom (e.g. SageMind - Adriana). From then on the agent runs on a real pool account, and auto-swap actually moves it when that account hits its weekly cap — which is the whole point of the load-balancing standard.
