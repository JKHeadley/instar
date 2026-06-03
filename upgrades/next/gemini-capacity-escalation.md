<!-- bump: minor -->

## What Changed

Adds `GeminiCapacityEscalationMonitor`, an observe-only signal that surfaces a **long** Gemini
capacity block instead of letting it be a silent outage.

#708's capacity policy correctly *defers* Gemini calls when Gemini reports a quota reset window
(e.g. live: "retry after 46758s" ≈ 13h), refusing doomed subprocesses until it clears — but it only
schedules/defers, it never *escalates*. A short defer is fine to absorb silently; a multi-hour block
means the agent/mentee is invisibly unavailable for half a day. This monitor reads the existing
`getGeminiCapacityGate()` module-global on a tick and raises **one** attention item per deferral
episode when the remaining window exceeds a threshold (default 60 min), re-arming when the block
clears. It never mutates the gate, never blocks a call. This closes item-3's "escalate, not silently
stall" half.

Config ships **OFF** (`monitoring.geminiCapacityEscalation.enabled`). When enabled, it rides
`TokenLedgerPoller`'s existing cadence via the same after-tick hook as the cycle-SLA monitor — no new
timer. Adds read-only `GET /gemini/capacity` (live gate: `blocked`, `remainingMs`, `deferredUntil`,
`reason`); 503 when disabled.

## What to Tell Your User

- **No more silent Gemini outages**: "If Gemini hits a long quota block (hours), I can now flag it
  instead of just going quiet — so you know the agent/mentee is capacity-blocked and for roughly how
  long. It starts turned off; ask me to enable it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Long-capacity-block escalation | Enable `monitoring.geminiCapacityEscalation` to get one attention item per multi-hour Gemini block. |
| Live capacity view | `GET /gemini/capacity` returns `{ enabled, blocked, remainingMs, deferredUntil, reason }` when the monitor is enabled. |

## Evidence

Verification:

- Unit (8): disabled no-op; not-blocked → no escalation; short defer → no; long defer → escalates once
  (HIGH ≥2h, NORMAL 1–2h); dedup across ticks within an episode; re-arm across a new episode; `status()`
  reports without escalating.
- Integration/E2E: `GET /gemini/capacity` through the real AgentServer — 200+shape when enabled, 503
  when disabled, Bearer auth required.
- `pnpm lint` (tsc + 4 lints) clean; `pnpm build` clean.
