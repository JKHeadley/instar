# Observable Intelligence — in plain language

## The problem

Your agent has a bunch of little "autopilot" helpers running in the background — the things we call sentinels and gates. They watch your messages, decide whether something needs action, and quietly handle housekeeping. Each one can ask an AI model a quick question to make its call.

Someone asked a simple, fair question: *"Which AI provider are these helpers actually using, and are they even doing any real work?"* And the honest answer was: **we couldn't fully tell.** The log that's supposed to track this had two holes in it:

1. It never wrote down **which AI** ran each check. So if you'd switched your sentinels over to a different provider (say, Codex instead of Claude), the log couldn't prove it.
2. It never wrote down whether a check **actually did something** versus just looked and found nothing. So every check looked identical in the data — you couldn't tell a hard-working guard from a useless one.

A helper that acts on your behalf but can't show what it chose to do is a helper you can't hold accountable. That's the gap this closes.

## What changed

Now, every time one of these helpers asks an AI a question, the system writes down: **which provider and model answered, whether the helper acted or found nothing, whether it got skipped to save on rate limits, how much it cost, and how long it took.** It records this at one shared "chokepoint" that every helper already passes through — so it covers all of them automatically, today and in the future, with nothing to remember.

There's a new **"LLM Activity" tab** in your dashboard that shows all of this in plain English: one row per helper, over a window you pick (last day, week, or month). You can finally see, at a glance, which helpers earn their keep and which are mostly idle or skipped.

## The balance

We don't keep this log forever — that would just be hoarding. It's kept about a month (you can change that), then old entries age out. Long enough to spot trends, not so long it piles up.

## Is it risky?

No. This only **watches** — it never blocks, changes, or slows down anything the helpers do. If the new tracking ever hiccupped, the helper would carry on exactly as before. It's all extra, additive recording, fully covered by tests.
