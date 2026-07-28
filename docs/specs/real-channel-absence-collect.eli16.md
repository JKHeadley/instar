# Real-channel "no surprise message" proof — plain-English overview

## The one-paragraph version

Echo has a safety check that proves it does **not** send a user a surprise background message — like the buggy "the throttle should have cleared, please continue" nudge that the earlier fix (PR #1262) stopped. That check could already run, but only against a *simulated* chat. This change lets it run against a **real Telegram or Slack conversation**, so the proof is genuine, not pretend. The way it works: after sending a test message, it watches the channel's history for a while and collects every message the agent posted, then checks that none of them is the forbidden surprise message.

## Why it was trickier than it sounds

Watching a real chat for "did anything bad show up?" has a sneaky failure mode: it's easy to *accidentally say "all clear" when you actually just didn't look hard enough*. That's the worst kind of bug for a safety check — a false "all good". The multi-angle review (six internal reviewers plus two non-Claude AI models) found **five** ways that could happen, and all five are now closed:

1. **The history was too long to read in one go** (pagination). If more messages existed than one read returns, a bad message could hide on a page we never fetched. Now: if the read might be incomplete, the check says "I can't verify this" (BLOCKED) instead of "all clear".
2. **A message got edited after we saw it.** Someone could post the bad message, then quietly edit it to something harmless before the next look. Now: we remember *every* version of a message we ever saw, so an edit can't launder it away.
3. **On Slack, a background message can come from a slightly different "identity"** (a `bot_id` instead of a user id). The old code would skip it. Now: we match both.
4. **The history read could quietly fail** (e.g. lost access) and return nothing — which looks identical to "nothing bad happened". Now: a failed read is BLOCKED, not a pass.
5. **Reading a real, long-lived test channel** (one that's been used many times) would have wrongly tripped the "too long to read" alarm even when everything was fine — making the whole check unusable on Telegram. Now: the check is smart about where your test message sits in the history, so a normal busy test channel works fine while a genuinely-truncated read still blocks.

## What changes for you

Nothing in day-to-day use — this is testing infrastructure that runs before code ships, not something on the live path you talk to. The payoff is indirect but important: it's another brick in the wall you asked for — making the tools refuse to give a green light they can't actually justify, so a "side effect of another feature" bug gets caught before it reaches the fleet, not after.

## The honest limits

This proves the absence of a *durable, visible* message in the chat history. It can't see a message that was deleted before anyone looked, or a Slack "ephemeral" message that never enters history — but those aren't the kind of message this guards against (the throttle nudge is a normal, durable post). If a disappearing-message bug class ever shows up, the next upgrade is to also tap the outgoing-send path directly. That's noted as future work, not pretended to be done.
