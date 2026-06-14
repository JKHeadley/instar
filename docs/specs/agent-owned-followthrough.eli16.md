# The Agent Carries the Loop — in plain English

## The problem

When the agent promises to do something later — "I'll check on this", "I'll report back when the build finishes" — that promise has to actually survive. Today two things go wrong:

1. **The agent quietly hands its job back to you.** It writes down a "commitment" whose next step is really *you* remembering to do something ("watch this", "go flip that switch"). That's backwards. You should never have to remember anything — the agent took the job, the agent keeps it.
2. **The agent's own promises rot.** There's a pile of "I'll do this shortly" notes from weeks ago that were never finished or closed. Nothing brought them back, so they just sat there.

## The fix

This change makes the agent structurally responsible for following through, so it can't slide back into either failure.

- **Every commitment says who drives it AND what it's waiting on** — two separate facts. "The agent is doing it" is different from "the agent is waiting on a vendor" is different from "the agent genuinely needs *your* input or a decision that's truly yours." Mixing those up is what created fake busy-work, so we keep them apart.
- **If it's the agent's to do, the agent does it** — and you hear nothing until there's an actual result. No status pings, no "still working" noise.
- **You only get pinged for two things:** a finished result you can use, or a genuine approval only you can give. That's it.
- **Nothing can silently get stuck forever.** If the agent is waiting on something outside its control, it has to keep showing real evidence it actually checked. If it ever goes quiet past a set time, you get exactly one honest heads-up ("I've been waiting on X for a while and it hasn't moved — want me to drop it or keep waiting?") — never a nagging stream, but never silence either.
- **The old pile gets cleaned up safely.** Stale promises are only closed when there's hard proof they're actually done; anything unclear is re-driven or surfaced once — never silently deleted (we've been burned by silent deletion before).

## What's deliberately left for later

The bigger, more sensitive idea — letting the agent *earn standing permission* so it stops having to ask for the same approval twice — is split into a separate, carefully-reviewed follow-up. Three rounds of review showed that part touches the security/authority machinery (who's allowed to do what) much more deeply, and rushing it alongside the everyday fix would be risky. It's not dropped — it's registered and tracked so it can't be forgotten.

## Why it ships quietly first

It turns on for the development agent only, in a watch-but-don't-act mode at first, so we can see it behave before it changes anything for real. You can always turn it off with one switch.

---

_Ratified by Justin on 2026-06-14; ships dark-on-fleet and live-in-dry-run on the dev agent first (it watches and logs, changing nothing) before any real behavior change. The "earn standing permission" follow-up is tracked separately._
