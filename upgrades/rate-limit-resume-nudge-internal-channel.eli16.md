---
user_announcement:
  audience: user
  maturity: stable
  summary: "When a rate-limit clears, the agent no longer appears to argue with itself in chat."
---

# The agent no longer argues with itself while recovering from a rate limit

When an Anthropic throttle hit a session, you could see something incoherent in the topic: the agent would post "heads up — hit a throttle, backing off," then a moment later post "no throttle on my end, still rolling," then "still throttled, next retry in 2m." Same agent, same topic, contradicting itself — and during a fleet-wide throttle (many sessions limited at once) it happened in several topics at the same time. The recovery always worked in the end; the *narration* of it looked like the agent was fighting itself.

Here is exactly what was happening. The rate-limit sentinel does two separate things when it detects a throttle:

1. It posts a user-facing notice to your topic ("hit a throttle, backing off, you haven't been dropped") — the heads-up you asked for.
2. After it backs off, it pokes the session with a "the throttle should have cleared — please continue where you left off" nudge, to un-stick it.

The bug was in step 2. That internal poke was injected into the session wearing a `[telegram:N]` prefix — the **exact** format a real message from you uses. So the session literally could not tell the difference between its own recovery infrastructure and you texting it. It treated the nudge as a message from you, answered it conversationally ("got it — no throttle on my end, still rolling"), and — because every message that looks like it's from you triggers the mandatory "relay your reply back to the user" rule — posted that denial into the topic. Right next to the sentinel's own "still throttled" notices. The sentinel was correct (there really was a throttle); the agent was answering the sentinel's poke as if it were you, and denying the throttle because from its seat the turn had finished fine.

## The fix

The resume nudge now goes through the **internal recovery channel** instead of the user-message path. It still un-sticks the session exactly the same way (both paths converge on the same low-level injection), but it no longer carries a `[telegram:N]` prefix — so the agent can never mistake it for a message from you, and never relays a contradictory "no throttle" reply. The dead user-message injection path for the resume nudge was removed entirely, so the bug cannot reappear.

The heads-up notices you DID ask for ("throttled, backing off" / "still throttled, retrying" / "back online") are unchanged. With the contradictory replies gone, those notices now read as a clean, coherent sequence instead of an argument.

## What you need to decide

Nothing. This is a behavior fix with no configuration. It takes effect on the next server restart after the update lands.

## How to verify it worked

The next time a session hits a throttle, watch the topic: you'll see the sentinel's notices in order, with no "no throttle on my end" denial interleaved. The internal nudge is recorded in `logs/sentinel-events.jsonl` as "resume nudge injected via internal recovery channel" (it used to say "via topic").

## The deeper lesson

This is the first enforcement of a new constitutional standard, **Truthful Provenance — Speak Only as Yourself**: every message delivered into an agent carries an identity, and the agent acts on who it believes is speaking before it acts on the words. Infrastructure must speak as infrastructure, never wearing the user's face. Tests pin the contract — the resume nudge can never again be injected with a user-message prefix.
