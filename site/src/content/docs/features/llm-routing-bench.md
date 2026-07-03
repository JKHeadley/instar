---
title: LLM Routing Benchmark Discipline
description: Benchmark-cited routing — a safety clamp that keeps bounded verdicts off the measured-banned Opus-via-Claude-CLI door, build-time lints that keep the routing registry honest, and an off-by-default monthly bench-refresh job.
---

Instar routes each internal LLM call (sentinels, gates, reflectors) to a framework-specific
provider. INSTAR-Bench established that routing must be per-task-**nature**, and that one route
is measured-banned for bounded verdicts: the identical Opus 4.8 model scores 99.1% on bounded
judging through a clean API but only 81.7% through the Claude Code CLI door (a 17.4-point "door
penalty"; 73% on emergency-stop). The Claude Code harness wraps every prompt in ~20k tokens of
"helpful coding agent" framing, turning a skeptical judge into a credulous assistant. Rules
R1/R2 forbid routing any bounded/gating verdict through that door.

## The safety clamp (R1/R2)

When a bounded or gating LLM call's primary provider fails, the router swaps down a fallback
chain. If that swap lands on `claude-code` requesting the `capable` tier (which resolves to
Opus), the router now **clamps the tier down to `balanced`** (Sonnet 4.6 CLI — 99.5%, 28/28
adversarial). This only ever *narrows* a dangerous fallback in the safe direction — it never
blocks a call, and it never touches the open-ended-writing quality lane where Opus-via-CLI is
the legitimate primary route. A build-time lint keeps the clamp intact and refuses any config
that routes a gating call to Opus-via-Claude-CLI.

## Keeping the routing registry honest

Two CI lints enforce the benchmark discipline structurally:

- **Routing-registry freshness** — every benched component must have a row in the human
  intentional-defaults doc (`docs/LLM-ROUTING-REGISTRY.md`). A new LLM component whose routing
  default was never intentionally decided fails the build.
- **Bench-cited nature** — each benched component carries its bench-established task-nature
  (bounded verdict / critical judgment / background digest) and production chain, so *routing*
  (not just existence) is benchmark-cited.

## The bench-refresh job

The `bench-refresh` job is a scaffolded, **off-by-default**, tier-1-supervised monthly job. On
the machine that carries the benchmark harness it reruns the bench + a parity-check and raises
**one operator-review diff** when a routing default looks stale — it never auto-applies a routing
change, and it silently no-ops on any machine without the harness. Enable it only on a maintainer
machine; a routing change always waits for a human's review. See the
[default jobs reference](/reference/default-jobs) for the schedule.

Everything here ships dark or reversible; no live routing default moves without operator review.
