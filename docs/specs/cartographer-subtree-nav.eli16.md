# Cartographer Subtree Navigation — Plain-English Overview

## The one-sentence version

Given a task, walk the codebase "map" and hand back just the handful of folders and
files that actually matter — so a helper agent can work with a tight, relevant view
instead of the whole repo.

## Why we need it

Earlier pieces of this project built a map of the codebase: a tree of plain-language
summaries, one per folder and file. The whole point of that map was so a helper agent
could find the relevant code *without* loading everything — but nothing actually used
the map for that yet. This is the piece that does. It's the capstone: it turns the map
from a thing you can look at into a thing that scopes work.

## How it works

1. **Score by relevance.** For a task like "fix the Telegram reply formatting," it
   scores each node by how well the task's words match that node's summary and its
   path. Distinctive code names count more than common words. No AI needed — it's a
   cheap text match.
2. **Walk top-down.** It starts at the root, looks at the children's summaries, dives
   into the most relevant branches, and repeats — reading the map level by level
   rather than scanning every file. That keeps it fast even on a big tree.
3. **Hand back the minimal relevant set.** It returns the smallest set of paths that
   covers the relevant code (collapsing a whole folder when most of it is relevant,
   keeping individual files when they're scattered) — exactly what you'd scope a
   helper agent to.
4. **Be honest about coverage.** If parts of the map haven't been summarized yet, it
   says so and falls back to matching on paths — it degrades gracefully instead of
   pretending.

It reads only local files, so it costs nothing and sends nothing anywhere. There's an
optional AI re-ranking step for the close calls, but it's off by default; the cheap
text match is the real engine.

## A safety note worth stating plainly

The summaries were written by an AI reading the code, so a summary is untrusted text.
When this hands a summary to a helper agent, it quotes it as data and declaws any
"ignore your instructions" phrasing first — a summary is a hint to go re-check the real
code, never an order to follow.

## What changed for users

A new lookup: ask "what's the relevant code for this task?" and get back a short list
of paths. It's off unless the map feature is enabled. Nothing else changes; it never
acts on its own — it just answers, and you decide what to scope a helper to.

## The main tradeoff

Cheap-and-deterministic beats clever-and-expensive: an earlier sibling feature was
redesigned twice specifically to avoid leaning on an expensive AI pass, and this one
takes that lesson — the AI re-rank is optional polish, the text-match is the authority.
