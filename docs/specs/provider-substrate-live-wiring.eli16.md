# Plain-English Overview — Making the June-15 Survival Mode Real

## What is this?

On June 15, Anthropic changes how Instar's background brain gets billed.
Instar talks to Claude in two ways: your actual conversations run in
interactive sessions (safe — they bill against the normal subscription,
nothing changes), but all the invisible background work — the safety
checks, message screening, sentiment gates, intent extraction — runs as
thousands of tiny one-shot `claude -p` commands. After June 15, those
one-shots start drawing from a separate prepaid $200/month pot, and when
the pot runs dry, they just FAIL.

Back in May we built the escape hatch: a "pool" of long-lived interactive
Claude sessions that Instar can type those background questions into —
the same way a human uses Claude, billed the same safe way as your
conversations. It passed its tests. But the last step — actually plugging
it into the running server — was deferred and never happened. The escape
hatch existed; the door to it was never installed.

## What's new in this change?

Three things, all wiring:

1. **The adapters are now actually registered when the server boots.** The
   routing brain that was installed in May finally has real options to
   choose between, and it reads the real credit balance instead of a
   hardcoded "I don't know."
2. **A new switch: `intelligence.subscriptionPath.mode`.**
   - `off` (the default everywhere): nothing changes. Bit-for-bit, today's
     behavior — a test literally pins the exact command line so we'd catch
     any accidental drift.
   - `auto`: spend the prepaid pot first while it's healthy, and
     automatically slide over to the interactive pool when the pot is
     unknown or nearly empty.
   - `force`: EVERYTHING goes through the interactive pool — zero one-shot
     commands. This is the proof mode ("run a full day purely on
     interactive sessions") and the emergency lever if June 15 goes badly.
3. **A window to check it: `GET /providers/registry`** shows what's
   actually plugged in — so "is the escape hatch installed?" is a question
   you can answer in one request instead of trusting a claim.

Sensible details: the pool runs the small/cheap model for this background
chatter (so it doesn't eat the big-model quota), works out of an empty
scratch folder (so judgment calls don't accidentally absorb project
context), spawns nothing until first use (boot stays fast), and gets shut
down cleanly with the server (no orphaned sessions).

## What do you need to decide?

Nothing today — the switch ships OFF for everyone, so this merge changes
no behavior anywhere. The decision points come next in the arc: flipping
echo to `force` for the one-day soak (the "make SURE" proof), and after
that, what the fleet default should be before June 15. Both will come to
you as explicit, reversible config flips with the soak results in hand.

## What's deliberately NOT here yet?

Scheduled jobs and agent-to-agent replies still spawn one-shot commands —
moving those is the next PR of this same tracked effort (CMT-1105), along
with the soak itself. This PR is the foundation they plug into.
