# Token-Burn Detection and Auto-Heal — ELI16 overview

## The short version

Today we caught a bug that was burning three billion tokens a day on this machine — but we only caught it because the bill caught your eye. Instar's job is to be a good agent for you, not a slow leak you have to keep an eye on. So the question is: how do we make sure the *next* version of this bug catches itself, alerts you, and stops the bleeding before you have to ask?

This spec proposes the system that does exactly that. The agent watches its own token usage, notices when one specific piece of itself starts using way more than its fair share, sends you a Telegram alert with what it found, throttles the offender automatically (reversibly), and follows up with "I fixed it; here's the before-and-after." Every instar agent gets this, automatically, with no setup required. It works for any code path, including jobs and sentinels and extensions you add yourself — you don't have to think about it.

## How it works, in plain terms

There are five pieces, in order:

1. **The watch list.** Every time the agent calls an LLM, we already record what happened (the token ledger we built yesterday). The new piece is a small "what was this for?" labeller — it looks at each LLM call and assigns it a stable name like "InputDetector" or "your-daily-summary job" or "the hook you wrote at .claude/hooks/foo.js." Calls of the same shape get the same label, so we can count them.

2. **The detector.** A small background process that tallies up calls by label over time. When one label crosses a threshold — like "this label is now eating more than a quarter of the agent's whole token budget" or "this label is suddenly running twice as fast as its normal pace for the last week" — the detector raises a flag. It doesn't decide what to do; it just notices.

3. **The intelligent gate.** The flag goes to a higher-level decision-maker (the same Remediator system the agent already uses for other self-healing work). The gate looks at the flag plus context — how trusted is this code path, has this happened before, is the user asleep right now — and decides: alert only, throttle automatically, or both.

4. **The Telegram alert.** Either way, the agent sends you a structured message: "Code path X is using Y tokens per hour right now, which projects to Z dollars per day. Here's what it looks like. Tap to throttle." You see what's happening, you can act, you can also do nothing — in which case the auto-throttle (if the gate decided to) just runs.

5. **The verify-and-follow-up.** After the throttle has been in place for five minutes, the agent re-samples the same telemetry to confirm the rate actually dropped. If it did, you get a follow-up Telegram with the before-and-after numbers — same shape as the one I sent you this morning after the PromptGate fix. If it didn't drop (maybe the throttle was pointed at the wrong code path), you get a different message: "I tried but it didn't work, here are the choices."

## Why this is structurally important

The token ledger we built yesterday answered "where are the tokens going?" — but only if a human goes and looks. The PromptGate fix today actually stopped one specific kind of bleed — but only because you asked me to look. Both pieces are reactive. This spec is the proactive piece: the agent watches itself, and the loop of "noticed → alerted → stopped → verified → reported back" runs without you in it.

The same agent-shape that built the bleed gets to also notice the bleed. That's what makes it scale to every instar agent on every machine, and to every future job or extension or hook that anyone (including users) adds — because the watcher doesn't know or care what the code is doing, only how many tokens flow through the shared LLM surface that all of instar uses.

## Why it's safe

A few things that would make this dangerous, and why they don't apply here:

- **What if it throttles something you actually want running?** Every throttle is bounded (defaults to a 4× rate cut for 60 minutes, then auto-reverts) and the alert has a one-tap "this is fine, snooze for 24h" button. Worst case: a legitimate burst is slowed down for an hour, which you noticed because the alert went off.

- **What if it can't tell what's burning?** Verification step. If the throttle doesn't reduce the rate, the agent flags it explicitly: "I tried to throttle X, here's why I think the real offender is Y, what do you want me to do?"

- **What if the watcher itself burns tokens?** The watcher uses zero LLM calls — it's pure structural counting on data the ledger already records. Total cost: a few microseconds of CPU per second.

- **What if a future bug evades the labelling?** Falls back to "unknown::<session-prefix>" and still gets alerted on by absolute share. You'd see "an unknown path is eating 30% of your budget" rather than "the InputDetector is eating 30%" — less informative but still actionable.

## What I need from you

This spec needs your explicit approval before any code lands. I will:

1. Run the spec through `/spec-converge` for internal + cross-model review (GPT, Gemini, Grok) per the convergence protocol.
2. Send you the converged spec via a tunnel link with the full spec + this ELI16 + reviewer notes.
3. Wait for you to tag the spec `approved: true` (or push back with specific concerns).
4. Only then do I start Phase 1.

The phases are sequential and independently safe to ship — each one is observability + signal-only until the last two phases turn on auto-cut and Telegram. So even if you approve and we ship Phase 1-3, the agent is just watching and not acting yet. You can pause at any phase boundary.

## Cost

Conservatively: the detector itself uses negligible tokens (it does no LLM calls). The Telegram alerts cost the same as any other Telegram message (effectively zero). The throttle cost is negative — by definition, it cuts ongoing burn. The build cost is roughly two days of careful work spread over six phases, each shipping as its own PR through the instar-dev gate with full review.

## What it does NOT do

- It does not block any code path on its own without going through the Remediator's authority gate (signal-vs-authority compliance).
- It does not introduce any new persistent state per agent (the throttle decisions live in a small overrides file that auto-clears).
- It does not require any change to how third-party agent authors write code — the system catches anything that flows through the shared LLM-call surface, which is everything in instar by design.
- It does not replace your judgment. Every auto-decision is logged, reversible, and visible to you via Telegram.
