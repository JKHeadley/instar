# Explain it like I'm 16: let Codex agents run on their own, too

## The setup

Some of our AI agents run on Anthropic's Claude; others run on OpenAI's Codex. When you put an
agent in "autonomous mode," it's supposed to keep working across many turns on its own — do a
step, keep going, do the next step — until the job is done, instead of stopping after one turn.

For a **Claude** agent this already works: a little "stop hook" nudges it to continue each time
it tries to stop. For a **Codex** agent, that nudge approach doesn't fit — but Codex has its OWN
built-in way to keep going: a command called `/goal`. You hand `/goal` the objective, and Codex
drives itself turn after turn until it's met. We already proved this works (Codex counted 1, 2,
3 across separate turns on its own).

## The problem

We already had code to hand the goal to `/goal` automatically when autonomous mode starts. But
that code had a gate that said, in effect, "only do this if Claude's command-line tool is
version 2.1.139 or newer." That check makes sense for Claude — but a **Codex** agent doesn't
have Claude's command-line tool at all, so the check comes back empty and **fails**. Result:
Codex agents silently never got handed to `/goal`, and so a Codex agent in autonomous mode
would quietly stop after one turn instead of continuing. The capability was there; the wiring
just had a Claude-shaped hole that Codex fell through.

## The fix

Add a small fallback right after that Claude version check: if the Claude check didn't pass,
look at the agent's own config to see if it's a Codex agent (its `enabledFrameworks` list
contains `codex-cli`). If so, turn the native-`/goal` hand-off on — because Codex has `/goal`
and we've proven it works. Now a Codex agent in autonomous mode automatically drives itself
with `/goal`, just like a Claude agent drives itself with the stop hook. Same outcome —
"keep going until done" — for both.

## Why it's safe

It's a five-line, additive fallback. The Claude version check is completely untouched, so
nothing changes for Claude agents. We don't touch the sensitive stop-hook at all (the part
that defers to `/goal` was already there and already proven). If, for any reason, reading the
config fails, the worst case is we just fall back to exactly the old behavior — no regression.

## Making sure existing agents get it

The setup script lives inside each agent and isn't auto-overwritten, so we bump a little
"version marker" the update process watches for. Agents that have the older setup (with the
Claude-only gate) get the fixed script automatically on their next update; agents that
customized their script are left alone; agents already updated skip.

## How we know it works

Tests check both sides: a Codex agent turns native `/goal` ON; a Claude agent leaves it OFF;
a mixed agent that includes Codex turns it ON; and the update correctly re-deploys the fixed
script to older agents. The final proof is driving a real Codex agent through autonomous mode
and watching it sustain multiple turns on its own.
