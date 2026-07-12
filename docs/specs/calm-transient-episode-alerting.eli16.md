# Calm Transient-Episode Alerting — Plain-English Overview

> The one-line version: your machines stop buzzing you about problems they're already fixing themselves — and the alarms that remain become trustworthy, because the clocks behind them can no longer be silently wiped.

> **Status:** operator-approved 2026-07-12 ("Yes, approved. Please proceed with your recommendations."); built the same day behind the dev-agent gate — live on the operator's machines during soak, dark on the fleet until the graduation checkpoint.

## The problem in one breath

On July 11 your Attention topic filled with high-priority alarms during a routine software update: "my machines have drifted apart!" — followed minutes later by "never mind, restored." Every one of those alerts was about something the system healed on its own. You were being buzzed, at decision priority, about the middle of a self-repair. And when we dug in, it got worse: the "safety net" that was supposed to guarantee you hear about a genuinely stuck machine within a few hours turned out to be broken — its timer silently reset every time the stuck machine inched forward or blinked offline, which is exactly what stuck machines do.

## What already exists

- **A machine-coherence guard** that compares your machines every 30 seconds and raises an alarm when they drift apart (different versions, different settings). It already has a 45-minute grace period for routine update waves — but the grace clock lives in a data structure that gets wiped by the very events it's timing.
- **A connection prober** that tests the links between your machines and posts a notice when a link is slow to recover. Informational by its own wording ("probing continues") — but it lands in the same alert topic as real problems.
- **A daily connection digest** that can summarize link health — but it only sends if configured, only runs on one machine, and (we verified) doesn't even have a category for the "slow but recovering" state.

## What this changes, in plain terms

1. **Routine self-healing updates make no sound at all.** The in-progress notice still appears in the topic and on the dashboard (you can always look), but your phone doesn't buzz. The rule we're following is simple: if the message would have to say "no action needed," it shouldn't make noise.
2. **The first buzz is the first real decision.** You get buzzed when a machine is genuinely STUCK (no progress past a hard ceiling, default 3 hours), when the same problem keeps coming back (3 times in a day), when the drift is a real capability split (major version difference — immediate), or when lots of little self-healing episodes pile up in one day (a pattern worth a look). Each of those arrives loud, with the decide-something prompt attached.
3. **The clocks behind those alarms become wipe-proof.** The stall ceiling and the "keeps recurring" counter move into durable storage, keyed so that version changes, restarts, machines blinking offline, and role handoffs can't reset them. This was the round-1 review's biggest catch: without this, the 3-hour guarantee was decorative.
4. **Alerts clean up after themselves.** When a problem heals, everything it posted gets marked done — including on a machine that handed off its speaking role mid-episode (today those orphaned alerts stay open forever). If an episode escalated loudly and then healed, you get one clear "stand down — it fixed itself" note.
5. **Informational link chatter goes to the digest — but only where the digest actually delivers.** If the digest isn't configured on the machine raising the notice, it falls back to the alert topic rather than vanishing into a log nobody reads. And a link that keeps flapping shows an honest "5th episode today" counter instead of five separate alerts.

## The safeguards

- **Every failure direction points louder, not quieter.** Unreadable data, a broken predicate, an unconfigured digest — all fall back to today's behavior or noisier.
- **Nothing about detection changes.** The guard watches exactly as before; only the narration (when, how loud, how often) changes. All of it lands in audit logs and counters, so "quiet" is provably different from "dead."
- **It ships to your machines first, dark everywhere else.** The calm behavior goes live on your own two machines behind the standard development gate, with a before/after buzz report as your sign-off checkpoint before it ever reaches the fleet. Every behavior has an individual rollback switch back to today's exact narration.
- **Three review rounds, seven reviewers per round** (including a non-Claude external model and the constitution-reading conformance gate) verified this design — round 1 killed a broken foundation, round 2 caught four mechanical gaps in the fix, round 3 verified everything closed with zero material findings remaining.

## What you actually need to decide

Approve the spec (the frontmatter `approved: true`), knowing the one genuine trade: a stuck-machine alarm that used to arrive at ~45 minutes now arrives at the 3-hour ceiling (configurable) — in exchange for zero buzzes on every routine update wave, alarms whose timers can't be silently wiped, and alerts that clean up after themselves. The final graduation to the wider fleet waits for your explicit OK after you've lived with it on your own machines.
