# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Background pollers now back off when the agent is idle — trimming wasted work
from the always-on CPU floor.**

Each instar agent runs a couple dozen timer-driven background monitors. On an idle
agent (no active sessions) most still wake on a fixed cadence and do work — log
scans, session captures, ledger rollups — for no reason. Across many always-on
agents on one machine, that fixed-cadence churn is a real slice of baseline CPU.

This adds a reusable `IdleAwareCadence` primitive: a self-rescheduling timer that
runs short while active and long while idle, re-checking the idle state on every
cycle so it snaps back to full speed the moment work resumes. The first poller to
adopt it is the token-usage scanner (`TokenLedgerPoller`): when no session is
running there are no new tokens to attribute, so it backs off from every 60s to
every 5 minutes. The mechanism is built so the other pollers — and, later, a full
agent-sleep mode — can adopt it incrementally.

This is the first slice of Level 1 (idle footprint) of the Responsible Resource
Usage standard. (instar can't hibernate the MCP servers Claude Code spawns, so the
in-scope win is making instar's own pollers cheaper when idle.)

## What to Tell Your User

Nothing to configure. When an agent is just sitting idle, its background checkers
now run less often instead of waking up on a fast timer for no reason — so each
agent uses a little less CPU when nothing is happening, and speeds right back up
the moment you give it work. It is conservative by design: it only changes how
often these checkers run, never what they do, and if it is ever unsure whether the
agent is idle it stays on the fast schedule.

## Summary of New Capabilities

- New `IdleAwareCadence` (`src/monitoring/IdleAwareCadence.ts`) — reusable
  active/idle self-rescheduling timer; `isIdle()` throw degrades to active;
  `tick()` throw never breaks the loop; `currentIntervalMs()` for observability.
- `TokenLedgerPoller` gains optional `isIdle` + `idleIntervalMs` (default 5 min);
  without them it keeps the prior fixed cadence exactly.
- `AgentServer` wires the token poller's idle signal to "no running sessions."

## Evidence

- `tests/unit/IdleAwareCadence.test.ts` — active interval, idle backoff,
  active→idle re-evaluation, `isIdle`-throw⇒active, `tick`-throw-survives, `stop()`,
  `currentIntervalMs`.
- `tests/unit/token-ledger-poller-idle.test.ts` — the poller backs off while idle,
  runs full cadence while active, and keeps the fixed cadence without `isIdle`.
- `tests/unit/token-ledger.test.ts` + `TokenLedgerPoller-codex.test.ts` green
  (backward-compatible). `npm run lint` clean.
