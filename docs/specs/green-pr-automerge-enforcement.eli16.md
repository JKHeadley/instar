# Green-PR Auto-Merge Enforcement — Plain-English Overview

> The one-line version: when a code change I authored has passed every review, gate, and
> test, a background watcher merges it — nobody has to remember to click anything, and I
> can't hand the click back to you.

## The problem

Twice now (June 9 and June 12) I finished a change, watched it go fully green, and then
told Justin "merge is yours whenever you're ready." That's backwards: by the time my own PR
is green it has already been through the converged spec review, the commit gates, and the
full CI suite — it is pre-approved by definition. Handing the click back creates manual
work, and on June 12 it also cost real time: while the PR sat waiting, the main branch
moved and the PR went stale, forcing a whole extra conflict-fix-and-retest round.

The June 9 fix was written into my build instructions ("Phase 7: merge it yourself, never
ask"). It failed anyway — the session running the build crashed, and the sessions that
picked the work back up never saw that instruction. A rule that lives in instructions dies
with the session that read them.

## The fix — two layers, both structural

**1. A watcher that merges for me.** A small background component checks every ~10 minutes:
do I have any open PRs that I authored, that are fully green, and that aren't marked as a
deliberate hold? If yes, it merges the oldest one — through the same `safe-merge` script the
instructions already mandate, which independently re-verifies that every check is green
before touching anything. It merges at most one PR per pass, backs off and eventually gives
up loudly (one combined heads-up, never a spam) if merging keeps failing, and writes every
decision to an audit log. If a PR is *supposed* to wait (like the one deliberately titled
"[HOLD: merge = cutover flip]"), the watcher leaves it alone — a `[HOLD` title or a `hold`
label always wins.

**2. A nudge at session exit.** The same guard that already stops me from ending a session
mid-promise gains one more check: if I try to end a session while a green unmerged PR of
mine exists, it blocks me once and says "merge it or mark it [HOLD]". If anything about
that check errors (no network, no GitHub tool), it lets the session end — it can nudge, it
can never trap.

## What it will NOT do

- It never merges anyone else's PR — only ones I authored myself.
- It never merges anything red, conflicted, draft, or held — and the actual merge decision
  is made by the existing verifier script, not by new code.
- It doesn't resolve conflicts; a stale PR is reported, and fixing it stays my job.

## Open questions for you

None blocking — per your standing directive I resolved the design forks myself (reported in
the spec's Decisions section). The one worth your eyes: **this ships live on me immediately,
with no observe-only soak** — my reasoning is that you've now directed this twice, the merge
itself was already mandatory-but-manual, and the verifier re-checks everything; the
observe-only ritual would just recreate the waiting you're trying to kill. Say the word if
you want a dry-run period instead.
