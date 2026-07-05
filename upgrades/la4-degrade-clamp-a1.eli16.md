# ELI16 — LA4 unconditional degrade-path safety clamp (S4 Increment A1)

## The one-sentence version

When the model that a safety check wanted to use is missing, the agent used to quietly fall
back to the single worst model-and-door combination for that kind of check — this change makes
it fall back to the safe, sanctioned one instead, always, no matter what.

## The longer story

Instar routes its own internal "thinking" calls (the little sentinels and gates that watch for
danger, judge whether a task is done, decide if a message is safe) through an internal router.
Bench measurements proved something surprising: the SAME top-tier model (Opus) scores 99% when
reached through a clean API but only about 82% when reached through the Claude Code command-line
tool, because that tool wraps every prompt in thousands of tokens of "you are a helpful coding
assistant" framing that turns a skeptical judge into an agreeable yes-man. On the emergency-stop
classifier it even missed real STOP commands. So Opus-via-the-Claude-CLI is a genuinely BANNED
route for any bounded or gating verdict.

An earlier change (S2) already caught this on one path — the failure-swap loop. But the router
has a SECOND exit that was left unguarded: when the model a check is routed to has a missing
binary, the router "degrades" and just re-runs the call on the default door. If that default
door is the Claude CLI and the call asked for the top ("capable") tier, that degrade lands
exactly on the banned Opus-via-CLI route — a real, quiet fail-open sitting in the shipped code.

## What this actually does

This closes that second exit. On the degrade-to-default path, if the landing would be
Opus-on-the-Claude-CLI AND the call is a bounded/gating one, the requested tier is clamped down
to the sanctioned Sonnet-CLI reserve (which the bench shows is safe — 99.5%, beats even Sonnet
on a clean API for these gates). Open-ended WRITING calls, where Opus-via-CLI is legitimately
the BEST route, are deliberately left alone; and an unmapped, non-gating call is left alone too,
so nothing else changes.

## Why it is "unconditional"

The bigger nature-routing feature this belongs to ships dark (off) on the fleet. But this
fail-open exists in the shipped code independent of that feature. If the clamp only fired when
the feature was on, the real hole would stay open on every fleet agent in its default state. So
this clamp fires ALWAYS — even with the nature-routing feature unset — as a standalone safety
narrowing. That is why, honestly, this is NOT byte-identical on the degrade path: it deliberately
changes one thing (Opus-CLI → Sonnet-CLI) in the safe direction, and only that.
