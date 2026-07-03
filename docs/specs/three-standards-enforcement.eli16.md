# Plain-English overview — enforcing the three new standards

Earlier today you ratified three rules for how this agent should always behave. Ratifying the *words* is step one; this spec is step two — making each rule something the system *structurally enforces* instead of something a reviewer has to remember. That distinction is the whole point of our root principle, "Structure beats Willpower": a rule written in prose is a wish, a rule baked into a check is a guarantee. Each of the three rules had a specific hole where willpower was doing the work, and this design plugs each hole. None of this invents new authority for the agent, and none of it mints new constitutional text — the rules you approved are the rules; this is only the machinery that makes them stick.

## What each rule is, and how it gets teeth

**Rule A — the agent is always a multi-machine entity.** The gap: our spec-review already asks "what's this feature's cross-machine posture?" but it accepted the answer "machine-local by design" without pushing back. So a wrong answer passed just by being *stated* — which is exactly how the memory-fragmentation slip survived seven review rounds until you caught it. The fix: the default answer becomes "unified across your machines," and "machine-local" is now flagged as a real problem unless the spec names a concrete, allowed reason (a login that physically lives on one disk, hardware that's tied to one machine, or an exception you explicitly approved). A bare "machine-local by design" now fails the check.

**Rule B — self-heal before notifying you.** The gap: nothing stopped a watchdog from pinging you the instant it noticed a problem, instead of trying to fix it first. The fix: a watchdog's "message the operator" path is placed *after* it has already tried a bounded, logged self-repair and that repair has failed. You hear about an internal issue only when the system genuinely couldn't fix it itself — and nothing is ever swallowed silently, because every detection and repair attempt is still written to the audit trail.

**Rule C — notices go to the one alerts topic, never a fresh topic each time.** This one mostly already works (there's a flood-guard), but routing to the single hub topic was a *fallback* the guard happened to reach, not the *rule*. The fix: make hub-routing the explicit default for any notice that doesn't belong to an existing conversation, and add a test that proves stray notices land in the hub instead of spawning new topics.

## What I already decided (and what you can still override)

These three calls could have been left open for you mid-build, but convergence requires them to be
decided up front, so I made each one and wrote down the reasoning. You can override any of them at
approval — none is silently locked:

1. **Rule A's list of allowed "machine-local" reasons is closed to three, on purpose.** I stopped
   calling the list "exhaustive" (an outside reviewer rightly said that overclaims) — it's a
   *deliberately-closed allowed set*. The usual reasons someone reaches for (privacy boundaries,
   cost/speed, a per-machine cache, availability) are **denied by default** unless you explicitly
   sign off on one. Adding a fourth reason later is your call, not an author's convenience — that
   friction is the whole point.

2. **Rule B reaches watchdogs/monitors, not every message.** A one-off reply to you isn't a
   watchdog and shouldn't have to declare a self-heal step; anything that runs on its own and can
   fire repeatedly does. I also hardened B after review: a watchdog must list what its self-repair
   actually *does* (so a fake do-nothing "repair" is caught), must have a hard time limit past
   which you're told even mid-repair, and auto-escalates a repair that keeps failing over and over.

3. **The alerts hub stays per-machine for housekeeping; critical alerts are pool-wide — with one
   honest gap named.** Each machine has its own hub topic (that matches how the Telegram bot is
   bound). For *critical* alerts that's already safe: they go through the attention queue, which
   you can read merged across all your machines. The honest catch an outside reviewer pushed on:
   a merged *read* isn't a *push* — if you rely on being buzzed on Telegram, a critical alert still
   pings from the machine that raised it. So I've **elevated** the "one unified Telegram alerts
   stream" idea from a nice-to-have to a real reachability follow-up (tracked with a concrete id,
   not silently dropped) — it's out of this build's scope, but it's not dismissed as taste.
