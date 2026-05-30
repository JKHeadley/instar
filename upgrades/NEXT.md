# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The UnjustifiedStopGate now has a self-circuit-breaker, fixing a chronic
`/health` degraded-flood + subprocess churn on subscription agents.**

The stop gate rules on Stop events via a Haiku judgment call. On subscription
agents (no API key) that call goes through `ClaudeCliIntelligenceProvider`, which
spawns a `claude -p` subprocess — irreducibly ~5-6s — but the gate's client budget
is `clientTimeoutMs = 2000`. So on every subscription agent the gate times out on
EVERY stop: it fail-opens (never ruling), wastefully spawns+kills a `claude`
subprocess, and emits one `DegradationReport` per stop — flooding `/health` with
identical `degraded` entries (observed 22+) that look alarming but mean nothing.

After `breakerThreshold` (default 3) consecutive provider failures the gate opens
its breaker: `evaluate()` fails open IMMEDIATELY without spawning, for
`breakerCooldownMs` (default 5 min), then retries once (half-open); a reachable
provider resets it. The fail-open decision is unchanged — `breakerOpen` allows the
stop exactly like `timeout` — so the breaker only makes the unavoidable fail-open
fast (no doomed subprocess) and quiet (no per-event degradation, no rollup skew).
`breakerThreshold: 0` disables it.

## What to Tell Your User

Mostly invisible. This fixes a false alarm: on agents running without an API key, a
safety check was timing out on every stop, which made my health page show
"degraded" with lots of identical entries even though nothing was actually wrong —
and it was wastefully launching and killing a helper process each time. I added a
self-healing circuit breaker so it stops the wasted work and the false alarms and
recovers on its own. My actual behavior when stopping is unchanged.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stop-gate circuit breaker (self-healing) | Automatic; tune via the gate's `breakerThreshold` / `breakerCooldownMs` |
| Disable the breaker | `breakerThreshold: 0` |
| Breaker telemetry | `UnjustifiedStopGate.breakerState()` |

## Evidence

- **Live reproduction:** with all other agents paused (no load), Echo's `/health`
  read `degraded` with 22+ identical `unjustifiedStopGate.timeout` entries; a
  `claude -p` haiku call in the agent cwd returned in ~5-9s, far over the 2000ms
  budget — confirming the timeout-on-every-stop + spawn-then-kill churn.
- **Tests:** `tests/unit/UnjustifiedStopGate-breaker.test.ts` (5) — opens after K
  failures and stops calling the provider; half-open retry after cooldown;
  reachable-provider reset; `breakerThreshold=0` disables; a real timeout counts.
  Existing gate/route/db suites (42) green. `tsc` + lint clean.
- Spec: `docs/specs/STOPGATE-CLI-CIRCUIT-BREAKER-SPEC.md`. Side-effects:
  `upgrades/side-effects/stopgate-cli-circuit-breaker.md`.
