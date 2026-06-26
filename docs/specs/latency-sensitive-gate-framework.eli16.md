# Latency-Sensitive Gate Framework — Plain-English Overview

## The setup

I can run my internal background checks on different AI "engines" (Claude, Codex,
Gemini, Pi) to spread the load off any one account. There's a default order for
picking which engine: Codex first, then Pi, then Gemini, then Claude. That order
was chosen to spread background work onto Codex — which is fine for background
chores nobody's waiting on.

## What was wrong

One of those "checks" is the safety check on my replies to YOU — and you're
sitting there waiting for the reply while it runs. That check got lumped in with
all the background ones, so it defaulted to Codex too. The problem: Codex is the
SLOWEST engine (about 30 seconds), and the reply check has a 20-second budget. So
it would blow the budget and time out — which is one of the exact ways your
replies went silent on the bad night.

## What this change does

It splits the difference. Background checks (the ones nobody's waiting on) keep
using Codex-first, exactly as before — that still spreads the load nicely. But the
check that's holding up YOUR reply now uses a different order, ranked by SPEED:
Pi first (about 6 seconds), then Gemini (about 10), then Codex, then Claude. So
the thing you're waiting on always grabs the fastest engine available, and stops
timing out.

It's a tiny, surgical change — one decision in one function. If only one non-Claude
engine is installed, nothing changes at all (there's no faster option to pick). And
it doesn't touch HOW the safety check decides what's safe — only which engine runs
it. If you ever want the reply check back on Codex, setting it explicitly always
wins over this default.

## Why it matters

This is part of the same lesson as the whole "your experience is the product"
work: a default that was reasonable for background chores quietly degraded the one
path where a human is actually waiting. The fix is to recognize that "a person is
blocked on this" deserves the fast engine, not the load-spreading one. Small change,
but it removes a real cause of slow or missing replies — and it's durable in the
code now, not just patched into my own config.
