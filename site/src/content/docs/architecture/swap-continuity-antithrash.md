---
title: Swap Continuity & Anti-Thrash
description: Brakes on account swapping — stay put when every account is hot, dwell after a move, and never kill in-flight work for an optimization.
---

When an agent holds several subscription accounts, the proactive pre-limit swap moves a session off an account before it hits the wall. Unbraked, that optimization can turn pathological: on a day when *every* account is hot, the monitor ping-pongs sessions between equally-exhausted accounts — observed live as 72 account swaps in one day, each one a session kill + respawn that interrupts whatever the session was doing. Swap continuity + anti-thrash is the braking layer that makes the swap engine calm: swaps only happen when they genuinely improve things, and in-flight work is never killed for an optimization.

## The brake pipeline (`SwapAntiThrashEngine`)

Every proactive swap intent passes a deterministic brake pipeline before it may execute:

- **Stay-put when all-hot** — if every alternate account is also above the threshold (or unmeasured/stale), the session stays where it is (`all-hot` refusal). One reactive rescue at the real wall beats N pointless kills.
- **Per-session dwell** — a just-swapped session cannot be moved again for ~45 minutes, so two hot accounts can never trade the same session back and forth.
- **Destination must be materially better** — a swap only executes onto a target that is measurably cooler on a *fresh* quota reading (headroom + minimum-improvement bounds); never onto an unmeasured account.
- **Thrash breaker** — reversal patterns (A→B then B→A) and swap-frequency crossings open a two-tier circuit breaker that suppresses proactive swaps for a backoff window and raises one deduped attention item.

Every decision — executed, refused, deferred, proceeded-with-mitigations — is one JSONL row in `state/swap-ledger.jsonl`, written through `SwapLedger` (bounded segments, corrupt-line-tolerant hydration). Because the engine hydrates from that ledger at boot, dwell clocks, reversal windows, and an open breaker all survive a server restart — the brakes are restart-proof, not in-memory wishes.

## The in-flight work gate (`SwapWorkGate`)

The second piece protects the work inside the session being swapped. `SwapWorkGate` is a stateless busy predicate consulted at the `SessionRefresh` funnel — the chokepoint every session-killing mutation flows through. It composes two legs: is a turn in flight (a tri-state probe via `SessionManager.checkSessionWorkState`), and are live Agent-tool subagents running? Uncertainty fails toward *not killing work*: a session is idle only when every leg affirmatively says idle.

Caller class decides what a busy verdict means: a **proactive swap** defers (bounded by a deferral ceiling) until the work lands; a **reactive swap** (the continuity guarantee at a real rate-limit wall) gets a short grace window and then proceeds *with mitigations* — the respawned session's first prompt enumerates the interrupted subagents and re-injects the last unanswered inbound message; an **interactive refresh** gets a structured `session-busy` refusal (counts and ages only, `force:true` to override); sentinel **recovery** respawns are exempt. `ProactiveSwapMonitor` owns the deferral lifecycle, and `ModelSwapService` exposes an optional subagent-idle leg behind its own micro-flag.

## Rollout posture

Ships dark and dry-run first: the anti-thrash brakes live under `subscriptionPool.proactiveSwap.antiThrash` (default `dryRun: true` — would-refuse rows are logged, behavior unchanged), and the work gate's `subscriptionPool.swapContinuity.enabled` rides the dev-agent gate (dark on the fleet) and is restart-required. Observability is served on `GET /subscription-pool/proactive-swap` (`antiThrash` / `brakes` / `deferrals` blocks). See `docs/specs/swap-continuity-antithrash.md`.
