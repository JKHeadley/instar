# Plain-English overview — Teaching the failure-watcher to notice things on its own

## The problem in one line

We built a system that's supposed to watch for problems in how I build things and learn from them — but right now it can only "see" a problem if I personally stop and tell it about one. So it's wide awake and staring at nothing. The fancy Process Health dashboard tab will keep saying "all quiet" forever, not because everything's perfect, but because nobody's feeding it.

## What this change does

It gives the watcher four automatic ways to notice trouble, so it fills up on its own without me typing anything:

1. **When a build fails** — every time an automated check on a code change comes back red, the watcher notes it (which feature, which change). This is the big one — it happens often and it's always a real signal.

2. **When a change gets undone** — if someone reverses a change (a "revert"), that's a strong hint the original change was bad. The watcher catches that and either closes out the matching problem ("this got pulled") or records it as a learnable event.

3. **When something that shipped quietly breaks** — if a feature that was rolled out becomes unreachable or backslides, the watcher records it. This one's careful: we already have an internal "regressed" flag that fires for a couple of harmless reasons too, so the watcher only files the cases that are *actually* problems, not every flag-flip.

4. **When the system has to fall back** — when a part of me hits trouble and switches to a backup, that's a "degradation." Those happen a lot and mostly heal themselves, so this one is **opt-in**: it only records degradations for the specific parts you've told it to watch.

## The important guardrails

- **Everything is OFF by default.** Each of the four is its own switch. Nothing turns on without an explicit choice.
- **Nothing can break by being on.** If any feed hits an error, it quietly skips and moves on — it can never break a build, slow a request, or trip up another feed.
- **No duplicates.** If two feeds notice the same underlying problem, they merge into one record with a "seen N times" count, not two separate entries.
- **Stays silent.** These feeds just fill the record book. They never message you — that's a separate switch we already have (also off).
- **Honest about confidence.** It only says "I'm sure which feature this belongs to" when it can actually trace it through the code history. Otherwise it says "best guess" and keeps those out of the blame math.

## How it ships

In three small, safe steps — each its own switch, each shipped off, each maturing on the rollout board:

1. **Build failures + reverts first** — the two that come straight from the code history, are the highest-value, and add the least new machinery.
2. **The "shipped thing broke" detector next** — it needs careful handling so it doesn't flood the record book with non-problems, so it gets its own round.
3. **The fallback-events feed last** — opt-in, lowest priority, smallest.

## How it's being built

Slice 1 (build-failures + reverts) ships in two parts to keep each one small and well-tested: the build-failure watcher and its shared groundwork land first, then the revert watcher follows. Each part is off by default and proven with its own tests before it merges.

## Why it matters

This is the step that turns the failure-watcher from a pretty empty dashboard into something that genuinely learns. Once it's quietly collecting real failures on its own, the pattern-spotting and the "did our fix actually work" parts have something to chew on — and the whole loop you approved starts paying off. Right now it's a beautifully-built engine with no fuel; this is the fuel line.
