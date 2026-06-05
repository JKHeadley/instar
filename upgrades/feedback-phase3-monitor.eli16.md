# ELI16 — Phase-3 parity monitor + cutover gate

## What problem does this solve?

Before we flip the feedback system from Dawn's Portal to Instar (the "cutover" — a one-way
door), we run both processors side by side over real traffic for a while and check they
agree. That side-by-side check ("the parity comparison") already exists. What was missing is
the part that watches it *over time* and decides when it's genuinely safe to flip.

You can't trust a single green check. Traffic is bursty; one quiet minute proves nothing. We
need to see a real, sustained window where the two systems agreed on every report — and only
*then* allow the cutover. And crucially, the decision to flip must not come from an agent
"feeling confident" — it must come from an objective gate that an agent cannot fake.

## What this change adds

A small, pure `ParityMonitor`:

- You feed it each comparison pass (how many clusters were compared, how many divergences).
- It tracks the current **zero-divergence streak**. The moment any pass diverges, the streak
  resets to zero — so a single disagreement, even after a long clean run, sends us back to
  the start. No "mostly agreed" hand-waving.
- It exposes one method, `gate(now)`, that returns **cleared** or **blocked** with a reason.
  It clears only when the trailing run of passes is (a) all clean, (b) at least N passes
  long, (c) spanning at least a real time window (default one hour), and (d) covering enough
  clusters to be a meaningful sample. All four must hold.

That `cleared` boolean is the objective `parity-zero-divergence` condition. It's exactly what
the Coordination Mandate's "execute-cutover" authority reads: the agents can only flip the
one-way door when this gate — not their judgment — says the window is satisfied.

## Why it's safe

Pure logic, no database, no network, no boot wiring. It only ever *reads* comparison results
and *computes* a yes/no; it changes nothing and triggers nothing on its own. It's the
building block the cutover executor will consult. 9 unit tests cover every gate boundary:
too-few passes, too-short window, too-few clusters, the satisfied window, and the streak
reset on any divergence (including re-clearing only after a fresh full clean window).

## Plain-language risk

Near-zero, and the failure mode is conservative: if the policy is too strict, the gate just
stays *blocked* longer (cutover waits) — never the dangerous direction of clearing early.

## Durability note

The "they agreed" window can take hours to build up. If we kept it only in memory, restarting
the server in the middle would silently wipe the streak and we'd have to start over (or worse,
mis-measure the window across the restart). So each check result is appended to a small log file
and reloaded when the monitor starts — the window survives restarts. A half-written final line
from a crash is skipped cleanly, so one bad line never corrupts the rest of the history.
