# Process-footprint monitor — ELI16 overview

## The problem in plain words

On 2026-06-26 the machine running this agent crashed hard — a kernel panic that forced
a reboot. The trigger was resource exhaustion: too many processes piled up on one
machine (several full agent stacks plus their heavy helper "MCP" servers — a whole
Chromium for the browser tool, an Electron app for another — most of them sitting idle).
The number of processes climbed slowly over time until the operating system hit an
internal limit and gave up.

The painful part: nobody SAW it coming. The agent already tracks CPU and memory, but it
never tracked the simplest, most relevant number for this kind of crash — *how many
processes are running on this machine right now, and is that number climbing?* That
measurement was missing, so the buildup was invisible until it was too late.

## What this change does

This adds a small, observe-only monitor that fills exactly that gap. On an interval it
counts the agent-relevant processes on the machine and sorts them into buckets:

- **agent CLIs** — the per-session reasoning processes (claude / codex / gemini),
- **MCP servers** — the heavy, mostly-idle helper servers (Playwright's Chromium, etc.),
  matched by the same precise signatures the cleanup sweep already uses,
- **other node** — the agent's servers, lifelines, and wrappers.

It keeps a rolling window of those readings so a TREND is visible — is the count rising,
stable, or falling? You can read it any time:

`GET /resources/footprint` → `{ enabled, latest: { total, byKind, rssBytes }, trend,
overThreshold, samples }`

## What it deliberately does NOT do

It is **observe-only**. It never kills, throttles, or blocks anything — reclaiming
processes is the job of the existing reapers. This monitor only MEASURES, so it can't
cause harm. There is an optional heads-up that can fire when the count crosses a
threshold, but it's off by default ("measure first") — the goal of this first step is
just to make the climb visible.

It ships **dark** (off on the fleet, on for development agents) so it's exercised here
before any wider rollout, and every reading path fails safe: if the process scan fails,
the monitor keeps its last reading rather than crashing. The route returns a clear
"unavailable" (503) when the monitor is turned off.

The point: the next time the process footprint starts climbing toward danger, it will be
a number you can watch — not an invisible buildup that ends in a crash.
