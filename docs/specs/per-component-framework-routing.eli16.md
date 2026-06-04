# ELI16 — Per-component framework routing (Codex sentinel-offload)

## What this is, in plain English

Echo runs on Claude. But Echo isn't just the conversation you see — behind it run dozens
of little "sentinels" and "gates": small background checkers that each make a quick AI
judgment call ("is this message urgent?", "did the agent stall?", "does this reply match
the user's intent?"). Every one of those calls spends Claude quota. When Claude rate-limits
Echo, a big chunk of the blame is this background chatter, not the actual conversation.

The idea: let those background checkers run on a DIFFERENT AI framework — Codex — while Echo
keeps talking to you on Claude. Move the chatter off the Claude meter. Codex has its own
separate quota, so this is found money for the Claude budget.

## Why most of it already exists

Instar already speaks three frameworks (Claude, Codex, Gemini) behind one common interface,
and it already has a "size" dial (fast / balanced / capable) that automatically picks the
right model for whichever framework you're on — so a "fast" check becomes Haiku on Claude or
a small GPT model on Codex with no extra work. What's missing is the ability to say "these
specific components go to Codex, everything else stays on Claude."

## What the design review changed (this part matters)

I wrote a first draft, then had two reviewers attack it against the real code. They found my
draft was wrong about two things, which would have shipped a broken feature:

1. I assumed each framework already had its own "circuit breaker" (the thing that pauses calls
   when a provider is rate-limited). It doesn't — there's ONE global breaker shared by
   everything. So if Claude got limited, it would have paused Codex too, defeating the whole
   point. The fix: build a separate breaker per framework. That turned out to be the biggest
   piece of work, not a freebie.
2. I planned to decide each component's framework "when it's built." But the component's name
   isn't even known at build time — it's only known at the moment of each call, and half the
   components don't go through the build step I was targeting. The fix: decide the framework at
   the ONE place every AI call already funnels through, on each call. This is actually simpler
   and cleaner — one spot instead of editing 18 — and it means you can change the config and it
   takes effect immediately, no restart.

They also caught a nasty failure mode: if Codex goes down, naively dumping ALL the sentinels
back onto Claude at once would spike Claude exactly when you're trying to protect it — worse
than never moving them. So the fallback is now "smart": if Codex is just rate-limited, the
checkers fall back to their built-in non-AI heuristic instead of stampeding onto Claude.

## What you actually need to decide

You already approved this and said it should go through convergence — which it did, and
convergence improved it a lot. The remaining judgment call, already made: per-framework SPEND
caps (separate dollar budgets per framework) are deferred to a follow-up; the first PR ships the
per-framework breakers, which are the real isolation mechanism. Turning the whole thing on is
opt-in config; with no config, behavior is identical to today.

## Safeguards in plain terms

- Off by default — no config means nothing changes.
- A bad config value fails loudly at startup, not silently.
- A routing choice can never hard-crash a sentinel; worst case it degrades and reports.
- Rolling back is just deleting the config block (or reverting the PR).
