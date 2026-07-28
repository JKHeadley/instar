# Plain-English overview: Multi-Machine Lease & Poll-Ownership Robustness

## The situation in one breath

I run as one assistant spread across two computers (a laptop and a Mac mini). Only one of them should be "awake" and listening for your messages at a time; the other waits in reserve. All day on June 20 that broke in three different-looking ways — sometimes BOTH computers answered you, sometimes NEITHER did (hours of silence), and the "who's awake" badge kept flip-flopping between them. We patched it live by hand. This change makes the fix permanent and structural so it can't come back.

## What's actually being fixed

There are five connected pieces:

1. **Tie "who listens to your messages" to "who's the awake one."** Right now those are decided by two separate parts of the system that don't talk to each other, set once when a computer starts up and never rechecked. So when the awake role moves to the other computer mid-conversation, the listening doesn't move with it — which is exactly how you get either two-of-me or total silence. We connect them, carefully: a computer only *starts* listening after it's confidently the awake one (and double-checks that the other computer isn't already listening), but it *stops* listening instantly the moment it loses the role. Starting is the dangerous direction (two listeners fight), so we're cautious there; stopping is safe, so we do it immediately.

2. **A "stop the flip-flopping" circuit breaker.** If the awake badge bounces back and forth too many times in a few minutes, the system freezes it to a deliberate, agreed choice (one specific computer becomes the awake one) instead of letting it keep fighting itself.

3. **Stop the badge from needlessly re-stamping itself.** A bug made the awake computer throw away its badge and mint a brand-new one every couple of minutes (because the badge expired faster than the computer renewed it). Harmless-looking, but it's a symptom of a deeper timing mistake. We give renewals their own correctly-sized clock and let the computer keep the same badge — but ONLY when it can actually confirm with the other computer first, never blindly (renewing blindly during a network split is how you'd end up with two "captains").

4. **An early-warning for clock drift.** The real trigger for the overnight mess was the two computers' clocks drifting apart after a reboot — once they're more than 30 seconds off, they stop trusting each other's messages and the whole handshake silently breaks. We measure the drift, have each computer check *its own* clock (rather than blaming the other), and raise ONE heads-up *before* the 30-second cliff instead of after.

5. **A "is exactly one of me listening?" health check.** A simple guard that watches across both computers and flags it if zero are listening (you'd hear silence) or two are (you'd get double answers) — including using Telegram's own "someone's already listening here" signal, which works even when the two computers can't see each other.

## What changes for you

If this works, you stop seeing the symptoms entirely: no more two-of-me, no more unexplained silence, no more me telling you the role is flip-flopping. And if something *does* go wrong, you get a clear early heads-up instead of a silent failure.

## The honest tradeoffs

- The deepest root cause — the two computers keeping separate copies of the "badge" with no shared referee — is NOT fully fixed here; that's a bigger redesign for later. What we're shipping is a *correct, bounded* workaround that behaves right in the real two-computer case and, crucially, **fails safe** (a confused computer steps down rather than pretending to be captain).
- Everything ships **off on the fleet and on-for-me-first** so I test it on myself before anyone else gets it, and every piece has an instant off-switch that returns to exactly today's behavior.
- The pieces have to ship in a specific order (fix the clock + badge first, then the flip-breaker, then the listening-follows-the-badge part last) — turning the last one on too early could *cause* the very silence it's meant to prevent, so that ordering is enforced, not just suggested.

## Why review caught a lot before any code

The first design draft had two genuinely dangerous bugs that six independent reviewers caught: my "keep the same badge" idea would have let a network-split computer wrongly believe it was still captain (two captains = chaos), and a timing "guard" I proposed would have refused to start up on *every* computer at default settings. Both are fixed now — which is the whole point of designing-and-reviewing before building.

---
*Anchored to the constitutional standard "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions": when this agent runs on more than one machine it must behave as one coherent agent even when a machine, clock, or network rope degrades — which is exactly what these five fixes harden.*
