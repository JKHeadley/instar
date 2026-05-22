# RateLimitSentinel — the simple version

## What's the problem?

Sometimes when I'm working on something for you, Anthropic's servers get really busy and put up a
"slow down for a sec" sign. The error looks like this:

> Server is temporarily limiting requests (not your usage limit) · Rate limited

The key words are **"not your usage limit."** This is NOT you running out of your plan's hours. It's
just Anthropic's servers being briefly overloaded — like a busy signal on a phone line. It clears on
its own, usually in a minute or two.

Claude Code already tries about 10 times on its own before it gives up and shows that error. So by
the time you'd ever see it, the easy retries are already used up.

## Why it matters

Right now, when that busy signal shows up and my own retries run out, two bad things happen:

1. I poke the session to "keep going" **instantly** — which just slams back into the busy signal and
   wastes a chunk of your usage hours for zero results.
2. After that one poke, I go quiet. The session sits there until a cleanup process eventually shuts
   it down. **From your side, it looks like I vanished mid-task.**

That's the "dropped with no response" thing you spotted in the screenshot.

## What I'm building

A little watchdog called the **RateLimitSentinel**. When it sees the busy signal, it:

1. **Tells you right away** — "Hit a temporary throttle on Anthropic's side, not your usage limit.
   Backing off, still here."
2. **Waits before retrying** instead of hammering — 30 seconds, then a minute, then two, then five.
   Giving the servers room to recover is what stops the wasted-hours problem.
3. **Nudges the session to continue** after each wait, and checks whether it actually came back to
   life.
4. **Checks in with you every couple minutes** while it's still stuck — "still waiting, next try in
   2 min, haven't dropped you."
5. **Tells you it's back** the moment it recovers — "throttle cleared, continuing."
6. **Escalates if it really won't clear** after about half an hour — "this is on Anthropic's side,
   you can check status.claude.com, or just message me to retry."

## What it does NOT do

- It does **not** fight your real usage limit. If you've actually used up your plan's hours, that's a
  different message and a different system handles it (it just waits for the reset).
- It does **not** mess with Claude's own built-in retries — those still happen first. This only kicks
  in after they're used up.
- If anything goes wrong, there's an off switch (one config flag) that puts everything back exactly
  how it was.

## The one-line version

When Anthropic's servers say "too busy, try later," I'll wait patiently, keep retrying gently, and
keep telling you I'm still here — instead of burning your hours and going silent.
