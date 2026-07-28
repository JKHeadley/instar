# State-Coherence Registry — the plain-English version

## What we did

We counted every notebook the agent keeps. All of them. Two sweeps: one
through the code (what notebooks does the software create?) and one through a
real machine's disk (what's actually there, how big, how fresh?). Result:
about **100 different kinds of durable state** — and exactly **one** of them
properly syncs between machines today (the encrypted secrets vault).

## The four stamps

Every notebook got a stamp:

- **Must match everywhere** — if the Laptop and the Mini disagree about this,
  the agent is lying to someone. Examples: promises made to you
  (commitments), the to-do attention queue, who's who (relationships), which
  conversation belongs to which project.
- **Fetch-on-demand** — doesn't need constant syncing, but when a
  conversation moves machines, the new machine must be able to grab it.
  Example: the overnight work files that got stranded on the Mini. This stamp
  is the cheap fix for exactly that incident.
- **Genuinely private to one machine** — syncing would be wrong. Examples:
  each machine's cryptographic identity, its CPU readings, its queue of
  not-yet-sent messages.
- **Scratch paper** — rebuildable from somewhere else, so never worth
  syncing. Example: the token-usage ledger (recomputed from logs).

## The headline numbers

- **13 "must match everywhere" categories have zero working sync.** That's
  the work-list, ranked by how much it hurts you when they disagree.
- Some files **mix stamps inside one file** — the config file has both
  "fleet-wide intent" and "this machine's port number" in it. Syncing it
  whole would make two machines fight over a port. Those need splitting
  first; we wrote that down as a hard rule.
- The git-based sync we nominally have **doesn't actually run** on the dev
  machines (a safety guard disables it there) — so git can never be the only
  channel for anything important.

## Surprise findings (free value from looking)

The disk sweep found real mess nobody knew about: 782 leftover corruption
files from old failed repairs, a 411-megabyte audit log with no rotation,
three dead empty databases at old paths, and two memory databases that
quietly stopped being written four days ago. None of that is this project's
job to fix, but it's all written down with a cleanup list — counting your
notebooks turns out to be worth it even before you sync anything.

## What keeps this honest

The registry isn't a one-time report. Once the first sync code lands, a
build-time check walks the code for anything that writes durable state and
**fails the build** if that store isn't declared in the registry. New
features must say "here's my notebook and here's its stamp" on day one — so
nothing can ever again become machine-local by accident.
