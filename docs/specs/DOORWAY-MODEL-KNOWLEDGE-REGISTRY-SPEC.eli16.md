# Keeping our map of "which AIs can we reach, and what's the best one?" from going stale — in plain English

## The problem, in one sentence

We have several different *doors* we can walk through to reach an AI model — the Claude app, the Codex tool, pi, a paid Google key, OpenRouter, Antigravity — and we kept a list of "what's the best model behind each door." That list quietly went out of date, and nobody noticed until it started making us dumber.

## What actually went wrong (2026-07-03)

Some of our internal helpers were still pointing at an old Google model (`gemini-2.5-pro`) weeks after Google shipped a much newer one. Our list *said* that was the best, so the helpers used it — for weeks. We already had a little alarm that yells "hey, this list looks old" (shipped as PR #1359). But an alarm only *yells*; it doesn't go out and *check* what the newest models are. So a human had to remember to go look, and between those times, the list rotted. When your map of the world is wrong, your decisions are wrong, and you don't even know it.

## The fix — three pieces

**1. A proper "doorway map" that grows.** Instead of a thin list, we keep one real record: for every door — its name, how you reach it (a command-line tool, a direct API, or a subscription), whether it's actually installed and working *right now*, the top model(s) behind it with their exact names, the price if it costs money, when we last checked, and a running history of what changed. There are two honest halves: the *reviewed* map that ships with instar (the same everywhere), and a *live* per-machine record of "what this specific computer could actually reach when it last looked" — because a tool installed on one laptop isn't installed on another.

**2. A robot that re-checks on a schedule.** A background job wakes up (say weekly), knocks on every door, notes what it finds, compares it to last time, and tells us **only what changed** — a new door appeared, a better model showed up, a door went dead, or one of our pins fell behind. If nothing changed, it stays quiet (no nagging). It's careful about money: the scheduled check is free (it just asks each door "what models do you have?", which costs nothing), and the paid double-check is **doubly locked** — it won't spend a cent unless a human runs it by hand *and* has set a spending limit; with no limit set it simply refuses, so it can never run up an unlimited bill by accident. It's careful about crashes (one broken door doesn't kill the whole check) and careful about secrets (it only ever handles the *names* of API keys, never the keys themselves). It also *notices newly-configured doors* — if you drop a new paid API key in the vault, it says "hey, there's a new door here you haven't told me about" (it checks a known list of doors-to-look-for plus any new API keys you've added — it's not magically discovering doors nobody told it about, but it does catch the ones you set up and forgot to register). And it **physically can't touch our real files**: it's only allowed to write to its own little scratch note and to raise a flag — it can't edit the official map, the source code, or anything else, no matter how it tries. When it thinks the official map is out of date, it just raises a flag for a human to confirm the change.

**3. A written rule.** We add a standard to our "constitution": *a stale doorway/model map is a bug, not a chore.* Keeping it current is the job of a machine (the scan + the alarm), not of someone remembering to look. That's our core principle — "structure beats willpower" — applied to keeping up with a fast-moving AI world.

## What changes for you

If you ask "what models can I reach right now?" or "is our model map current?", there's a real, fresh answer to read instead of a guess. And the embarrassing "we were secretly using a year-old model" situation gets caught by a robot on a schedule instead of by luck.

## What ships carefully

Everything ships **off by default**. The scan won't run, and won't spend a cent, until someone deliberately turns it on — and even then the normal weekly check is free. Turning it on, changing how often it runs, or letting it spend a little money to double-check are all one-line, easily-reversible switches. The three choices worth your input: how often it runs (default weekly), whether it may spend a little money to verify (default no), and where the "something changed" note lands (default the attention queue).
