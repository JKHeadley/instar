# ELI16 — Proactive pre-limit account swap

## The problem in one picture

You have several Claude logins pooled together. The agent runs on one of them.
Each login has a usage limit (a 5-hour window and a weekly window). When the
login you're on hits its limit, the agent **wedges** — it can't talk until the
limit resets or someone manually switches it to a different login.

We already had a safety net for this called **auto-swap**: when a session gets
rate-limited, move it onto a fresh login and resume the same conversation. But
auto-swap only fires **after** you hit the wall. So you still get a blip — and
worse, the main session you actually chat with runs on the "default login" and
carries no tag saying which account it's on, so the swap engine couldn't even
find it. It just got stuck, and the operator had to swap accounts by hand. That
happened for real on 2026-06-09.

## What this change adds

A **proactive** swap that moves a session off a login **before** it walls.

- It watches each login's measured usage. When a login that has a running
  session crosses a threshold (default **80%**), it moves that session to a
  login with room to spare — pre-emptively, with the conversation preserved.
- Why 80% and not 99%? Our usage reading is polled, so it lags behind the real
  number (live, our 90% was the provider's 95%). Triggering at 80% leaves a
  margin so the swap finishes before the real wall.
- **It can see the session you actually use.** If a session has no account tag,
  the monitor figures out which login it's on by asking the default login's auth
  status, then treats that as the session's account. So the main interactive
  session is rescued instead of wedging.

## How it stays safe and calm

- It won't move a session onto another login that's also nearly full (no
  pointless thrash).
- It moves at most a few sessions per pass and puts each swapped session on a
  cooldown, so nothing stampedes.
- When a login is getting close, it refreshes the usage poll first so a fast
  burn isn't missed between checks.
- It's **off by default.** Moving live sessions is real authority, so an operator
  opts in with `subscriptionPool.proactiveSwap.enabled` — exactly like the
  reactive auto-swap switch.

## How you'd see it work

Turn it on, then either let it run on its own cadence, or run one pass on demand:
`POST /subscription-pool/proactive-swap/check`. The status route
`GET /subscription-pool/proactive-swap` shows the threshold and the last result.
Nothing changes at all unless you flip the switch.
