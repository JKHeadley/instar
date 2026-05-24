# Human-as-Detector — the plain-English version

## What this is

Right now, when you catch the agent getting something wrong — "that's out of date," "you
already told me the opposite," "why didn't you notice this?" — the agent just fixes it and
moves on. The correction itself gets thrown away.

That's a waste, because your correction is actually a really valuable clue. If *you* had to
catch the mistake, it means one of the agent's *own* automated safety checks — the things
that are supposed to catch stale facts, contradictions, and incoherence — failed to catch it
first. So every time you point something out, it's a little flag that says "a guardrail
missed this one."

This feature starts keeping score of those flags. Each correction you make gets quietly
logged and tagged with *which* guardrail probably should have caught it. Over weeks, that
builds a "heat map": a ranked list of which safety checks keep letting things slip past. That
tells us exactly where the agent's automated guardrails are weak and worth strengthening —
instead of guessing.

## Why it matters

It turns your feedback into a permanent, measurable signal instead of a one-off fix. It's the
"never let user feedback go to waste" idea, built as actual running code. It's also the first
working piece of the bigger "working awareness" goal — the part that learns from the moments
the agent slips.

## How it works (lightly)

A small, simple pattern-matcher reads each message you send. It uses no AI and no internet —
just a careful list of phrases that signal a correction (deliberately tuned to under-react, so
it doesn't cry wolf). When it spots a real correction, it records a short note. There's a
quiet read-only page (`/human-as-detector/summary`) where the heat map can be viewed.

## The tradeoffs and the safety choices

- **It only watches, never blocks.** This is a thermometer, not a gate. It records and
  summarizes; it never stops the agent from doing anything. So even if it mis-reads a message,
  the worst case is a slightly-off statistic — never a broken action or a dropped message.
- **It protects your privacy.** Your actual words are *not* written to disk — only the
  category of correction and which guardrail it points at. So if you happen to type a password
  or private detail while correcting the agent, it won't end up sitting in a log file forever.
- **It survives restarts.** The agent restarts often (updates, etc.); the heat map reloads its
  history on startup so it doesn't reset to zero every time.
- **It can be fooled, and that's okay.** Someone spamming "that's wrong" could skew the
  numbers — but since the heat map only informs us and controls nothing, that just makes a
  chart noisy, not the agent unsafe.
- **Telegram first.** This version watches your Telegram messages. Slack and the other channels
  are an easy, already-planned follow-up.

## What changes for you

Almost nothing visible day-to-day — it works silently. The payoff is slower and bigger: over
time, the agent's blind spots become *visible and measurable*, so we can fix the guardrails
that keep failing instead of patching the same kind of mistake over and over.
