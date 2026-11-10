# Upgrade Guide — quality-history-glance

## What Changed

The maturation board has a quality history page: `#/work/maturation?s=quality` in the console (or `/dashboard/maturation/?s=quality`). It shows one small history chart per measured item on this machine, worst first, each marking the goal (amber dotted line), the recorded starting point when one is verified (dashed line), and hollow dots where the comparison is not verified. Off-goal items have an "Ask what to do" link, and the board links to the page under its answer. The data comes from a new read-only `GET /maturation/board?part=quality` over the same measurement owner the per-item detail uses (dev-gated with the board, cached for a minute). Agents get a CLAUDE.md section telling them to send this direct link when they mean "the quality chart".

## What to Tell Your User

There is now one link that opens straight onto charts of how each measured feature is doing over time, worst first, on a phone or a computer. Each chart shows its goal, and says plainly when there is no recorded starting point to compare against.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Quality history charts | Console link ending `#/work/maturation?s=quality`, or "Quality history charts" on the maturation page |
| Quality history read | `GET /maturation/board?part=quality` |

## Evidence

Unit, integration and e2e tests listed in `upgrades/side-effects/quality-history-glance.md`. Loaded in Chrome at 390x844 (two charts on the first screen) and 1280x728 (six) against Echo's real measurement data: 292 items, 15 off goal, none with a recorded starting point.
