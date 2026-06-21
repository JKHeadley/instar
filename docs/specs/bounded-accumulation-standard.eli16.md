# ELI16 — Every place we save data needs a ceiling

## The problem in one sentence

Echo keeps lots of little files and databases on disk (logs of what happened, a
map of the code, a record of tokens used), and **a bunch of them only ever grow** —
nobody ever trims them — so one of them is now **256 MB**, another **91 MB**, and a
dozen logs are 5–14 MB each. That's wasteful, and worse, reading one of the giant
files all at once **freezes the whole program** for a few seconds (which is part of
why Echo's been having those brief "unresponsive" blips).

## Why it happened

Two bad habits, and **nothing in the code stops either one**:

1. **Append-forever logs.** Lots of files just add one line per event, forever, with
   no "delete the old stuff" rule. A flat list that only grows is a time bomb.
2. **Reading a huge file in one gulp.** When the program reads a 91 MB file all at
   once and turns it into objects, the single thread it runs on can do *nothing
   else* for seconds — health checks fail, and to a watchdog it looks frozen.

The operator already *believed* in a rule — "use smart tree-shaped data structures,
don't let any one thing pile up" — but it was only a belief written in docs, not a
rule the build enforces. So it got ignored. (Same thing that happened with the giant
CLAUDE.md file.)

## What this change adds

A real, enforced rule called **Bounded Accumulation**: *every place we save data
must declare a ceiling and stay under it.*

- A small **registry** lists every saved store and its limit ("keep 30 days" / "keep
  10,000 rows" / "max 20 MB").
- One **lint** fails the build if someone adds a new store with **no limit**.
- A second **lint** fails the build if someone reads a possibly-huge file **all at
  once on the main thread** (the thing that causes freezes) — they have to stream it
  or use a database instead.
- A **growth test** stuffs a store full and checks the file on disk actually stays
  under its ceiling, so the limit really works.

Trimming always drops the **oldest** first and **says what it dropped** — never a
silent loss. And it never trims things that are *still waiting to be acted on* (like
a pending to-do): those are limited by getting *done*, not by being deleted.

## What the reader (you) needs to decide

This spec is the **rule + the enforcement** (lints + test). It's mostly invisible —
it stops future bloat. Two follow-on pieces need your nod:

- **Retrofit:** turning on trimming for the stores that are *already* too big. Safe,
  reversible (each is a config flag).
- **One-time cleanup:** actually deleting the historical bloat that's there now
  (the 256 MB and 91 MB files). That step **deletes real history**, so I'm holding it
  for your explicit go — it's the one thing here I won't decide on my own.
