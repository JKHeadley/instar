# Cartographer Doc-Freshness — Plain-English Overview

## The one-sentence version

This is the engine that keeps the codebase "map" (built in spec #1) honest over
time — it notices when a description has gone out of date because the code under
it changed, and quietly rewrites that description, without ever becoming a
resource hog or leaking your private code somewhere you didn't agree to.

## Why we need it

Spec #1 gave every folder and file a short plain-English note plus a git
"fingerprint," so the map can tell — for free — which notes are out of date. But
a brand-new map has no notes at all, and as code changes, notes rot. *Something*
has to write the notes and re-write them when they drift. The obvious way (a job
that re-reads the whole codebase on a timer) is exactly the kind of background
process that has burned Instar before: it ran up huge model bills and starved the
machine's CPU. So the whole design is about doing this *cheaply and safely*.

## How it works — three tiers

1. **Inline (free).** When an agent edits a subsystem, it refreshes that one note
   right then, using a small write endpoint. No background cost — the agent
   already knows what it just changed.
2. **The sweep (the gap-filler).** A quiet background loop fills in the notes the
   inline tier missed. It finds stale notes for free (a single git command, no AI),
   then re-writes only a handful per run — using a *small, cheap* model that runs
   **off your main Claude account** so it never eats your Claude quota.
3. **The CI floor.** A check that fails the build only if overall freshness
   actually *drops* — never per-change nagging (the kind of gate people learn to
   swat away).

## What changed for users if it ships

Almost nothing visible, and only if you turn it on — it ships **off by default**.
When enabled, your map slowly heals itself instead of rotting. You'd flip two
switches: `enabled`, and a *separate* `egressAcknowledged`, because turning the
sweep on means your source code gets sent to whatever provider the small model
runs on. We made that its own explicit switch so it can never happen silently.

## The main tradeoffs (what review fought over)

- **Cost vs. coverage.** A background AI loop is dangerous. We bound it three ways
  (max files per run, max spend per run, yields under CPU load), only the
  lease-holding machine does the work (so your two machines don't double the bill),
  and it routes off Claude.
- **"Fresh" is not "correct."** A note can match the current code's fingerprint yet
  still be wrong. We made the system say exactly that — it never claims a note is
  *true*, only *current* — and it re-checks a small sample over time.
- **Trust.** A note is a hint to re-check against the real code, never an authority.
  That matters because a later feature (the navigator) reads these notes, so a bad
  note can't be allowed to mislead or smuggle in instructions.

## The big things review caught (and we fixed)

The "off-Claude" promise was originally *false* against the real code — the router
quietly falls back to Claude when the small model isn't set up. We added a runtime
check that refuses to run rather than silently spend your Claude quota. We also
caught that on a two-machine setup, both machines would have done the work twice
(double the bill and double the code leaving your box) — now only one does. And we
made sure a green "freshness score" can't hide a big pile of files that were never
documented at all.
