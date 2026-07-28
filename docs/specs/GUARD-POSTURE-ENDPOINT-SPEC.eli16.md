# Seeing every machine's safety systems from anywhere — the plan, in plain English

> **Status:** Approved by Justin (topic 13481) on 2026-06-12 — build in progress.

## What this is

A way to see, from anywhere, which of your machines' safety systems are genuinely working — not just switched on in the settings, but actually alive and doing their job. Your dashboard's Machines tab gets a line per machine like "Guards: 4 confirmed on · 1 needs attention," and one API call can sweep the whole fleet. A background check reads it automatically on a schedule, so a problem raises one alert even if nobody happens to be looking.

## Why it's needed (what actually happened)

Your Mac Mini's session cleaner was switched off during the June stability crisis and stayed off for a WEEK without anyone noticing — old sessions piled up until the Mini was down to 1.5% free memory. There was no way to even SEE it was off: checking required SSH (didn't work across networks) or spawning a temporary session just to read a settings file (broke twice mid-read when updates restarted the server). A safety system you can't see is a safety system that silently stays off.

## What's new — and what the review process sharpened

The design went through eight independent reviews (five specialist lenses plus three outside AI models), and they changed it substantially:

1. **"On in the settings" is not the same as "working."** The original design would have painted a crashed guard green. Now every guard reports an honest grade: confirmed working, on-but-unverified, on-but-frozen (it exists but its heartbeat stopped — exactly the Mini's failure), on-but-in-practice-mode, or off. A guard that's only "on paper" can never show as healthy.

2. **"Off" gets split into two very different things.** Many features ship switched off on purpose — that's normal, not alarming. The dashboard now only flags an off that DIFFERS from how things ship (the "someone turned this off during an incident" signature). Without that split, every machine would show a wall of ambers forever and the one that matters would drown.

3. **One definition of "what counts as a guard," shared with the existing tripwire** (the boot-time alarm that already watches for guards being turned off), plus a registration system so guards added in the future show up automatically — and a build-time check that refuses code adding a guard without registering it.

4. **It works even when a machine is unreachable.** Each machine's regular heartbeat now carries a tiny posture summary, so every machine remembers every other machine's last-known state — with its age shown honestly. The Mini being cross-network (the original problem!) no longer makes its posture invisible.

5. **The "turn it back on" switch got moved to its own project — deliberately.** The review caught that the existing remote settings lever silently wipes a guard's tuning while re-enabling it (it replaces whole settings blocks). A first draft of this design included a safe replacement switch, but the second review round proved that switch is a bigger deal than it looks: for several guard types it would be a brand-new remote power that doesn't exist today (including one that could double model costs with a single call). So this design stays purely read-only, the switch gets its own fully-reviewed design next, and in the meantime the agents' instructions gain an explicit warning about the existing lever's wipe behavior so nobody fires it unaware.

6. **Strict no-secrets enforcement.** The response is a fixed, short list of fields — never raw settings (some guard settings contain things like alert routing IDs that shouldn't travel). A test pins this.

## The safeguards, in plain terms

- **Read-only at its core.** The posture surface never flips anything by itself; the background check raises ONE grouped alert per incident and a human (or you, deliberately) decides. The only write is the explicit narrow on/off switch, behind the same authentication as every admin action.
- **Always on, no off-switch — on purpose.** An off-switch on the "is anything switched off?" surface would itself be an invisible disabled guard.
- **Honest about its own blind spots.** It reports how many guards it could actually verify versus take on faith, names every machine it couldn't reach and why, and a machine running an older version shows "needs update to report" instead of a fake outage.

## What you need to decide

Whether to approve building this. It's a moderate build (shared inventory module + endpoint + heartbeat summary + dashboard line + the background check + the safe switch + tests), reviewed to convergence. The payoff: what happened with the Mini's cleaner — off for a week, invisibly — becomes structurally impossible to miss, even on a machine you can't reach right now.
