# Session Error-Nudge Re-Arm — the plain-English version

## What broke

Sometimes the AI service has a hiccup — it returns an "API Error: 500" and the agent's
current turn just stops, leaving it sitting there doing nothing. The agent already had a
helper that notices this and taps it on the shoulder: "you hit an error, keep going."

The bug: that shoulder-tap only worked **once per session, ever**. The agent runs for
hours. The first hiccup got a tap. Every hiccup after that got nothing — the agent just
sat frozen until a human poked it. Over an 8-hour run, hiccups happen more than once, so
the agent kept getting stuck. The user saw it stop "again" and asked us to fix it.

## Why the obvious fix doesn't work

You might think: "just make the stop-hook restart it." But the stop-hook only runs when a
turn ends *normally*. An error-abort isn't normal — the hook never even gets a chance to
run. So the fix has to live in the *outside* watcher (the monitor that already does the
shoulder-tap), not inside the agent.

## The fix

Three small changes to the shoulder-tap:

1. **It re-arms.** As soon as the agent starts working again, we forget that we already
   tapped it — so the *next* hiccup gets its own tap. (Before: we remembered forever, so
   there was never a second tap.)
2. **It has a limit.** If an agent is truly broken and keeps erroring no matter how many
   times we tap it (50 in one session), we stop tapping and let the normal cleanup take
   over. We don't tap forever or waste money retrying a lost cause.
3. **The decision is a tiny, testable rule.** "Tap if we haven't tapped this round AND
   we're under the limit." Easy to verify both ways.

## What you'll notice

Long autonomous runs survive transient service hiccups on their own — the agent taps
itself back to work each time, instead of silently freezing after the first one. No
config to set; it ships to every agent with the next update.

## The bigger half: make the smart recovery cover ALL these errors

We already had a *smart* recovery helper for one specific case — when the AI service says
"slow down, you're sending too much" (a rate limit). For that, it doesn't just retry
instantly; it waits a bit, then a bit longer, then longer (so it doesn't make things
worse), tells you "I'm backing off, you're not dropped," checks whether the retry worked,
and gives up gracefully if it never does. That's exactly the behavior we want.

The problem: that smart helper ONLY knew about the "slow down" error. A regular hiccup
like "Error 500" didn't get the smart treatment — just the dumb instant tap.

The fix: teach the smart helper about the **whole family** of temporary hiccups (500,
502, 503, timeouts, dropped connections), not just rate limits. A 500 now gets the same
"wait, retry, check, escalate if needed" treatment — except the waits start short (5
seconds), because a 500 usually clears in seconds, whereas a rate limit needs minutes.

**Future-proof:** there's one list of "what counts as a temporary hiccup." Add a new kind
of hiccup to that list and it automatically gets the smart recovery — no extra wiring.

## What it does NOT do

It does not handle a genuinely-broken agent forever (there's a limit), and it does not add
a second separate watchdog (that would double-tap and fight itself). It reuses the smart
helper we already had and the simple tap we already had — just makes them cover the whole
family of temporary API errors instead of one case each.
