# Process Health Dashboard Tab — the plain-English version

## The one-sentence idea

Add a calm, human-readable page to the dashboard where you can see, at a glance, what the Failure-Learning Loop is finding — built deliberately to **not** look like a developer console.

## Why now

The loop is live (it's been quietly watching our own development since this morning), but everything it records is invisible — you have to know exactly which API endpoint to poke at to see anything. That means even when it eventually spots a pattern, you'd never know unless you went looking. This page makes the loop's work *visible*, so you can actually use it to make decisions ("is this thing working? worth turning the louder bits on yet?") instead of guessing in the dark.

## How it'll look (and how it won't)

Picture the difference between reading a friend's text message and reading a server log. We want the friend's text message.

**Top of the page** — one big, plain status line, like *"Healthy — no patterns flagged this week"*. Big enough to read across the room. That's it: that's the answer to "should I care right now?"

**Below that** — *"Patterns to know about"*. When the loop spots something, it shows up here as a short readable card: what it found, what it recommends, and whether the fix worked. Right now it's the friendly empty state ("nothing yet — needs more variety in the data first").

**Below that** — *"What's been captured"*. The recent failures it's seen, written as **sentences not table rows** — like *"concurrency bug in src/core/Foo.ts · attributed to ledger spine · 2 days ago"*. A "show all" link lets you dig in, but the default view stays calm.

**Then** — *"Maturation"*. A simple vertical list showing where we are in the four-stage rollout, with a clear *"← you're here"* mark. Right now: capture-only.

**At the very bottom** — a collapsed *"Detail ▾"* drawer. That's the one place where the dense breakdown lives (rates, buckets, distributions) — and even there it stays typographic, not table-shaped. **Closed by default.**

## What we're explicitly NOT doing

- No tiny developer-console font. Body text is large, breathable, readable from a phone or across the room.
- No walls of monospace text. No JSON dumps. No alternating-row "table" feel.
- No frantic colors. The only status color is on the headline badge, and it's a calm green or amber — never an alarming red for a routine observation.
- No "open everything, drown the reader." Detail collapses. Plain summary leads.

## The one rule that drives every decision

If a non-engineer opens this page and within five seconds can't tell us "what's happening / what should I look at" in plain English, the spec has failed — regardless of whether the numbers are right. That's the acceptance bar.

## What you actually need to know

When this ships, the dashboard gets one more tab — "Process Health" — that you can tap from your phone or laptop. It refreshes itself quietly. It tells you in plain language what the loop is watching, what it's spotting (if anything), and where the rollout sits. Nothing changes about the loop itself; this is the human window into it. And the visual style we land on here becomes the bar for any future dashboard work — no more debug-looking pages.
