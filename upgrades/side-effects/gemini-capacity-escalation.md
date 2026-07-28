# Side-Effects Review — GeminiCapacityEscalationMonitor

**Version / slug:** `gemini-capacity-escalation`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

A new observe-only monitor reads the existing `getGeminiCapacityGate()` module-global on the
TokenLedgerPoller after-tick cadence; when Gemini is deferred for ≥ `escalateAfterMinutes` (default 60)
it raises ONE attention item per deferral episode (deduped on `deferredUntil`), re-arming when the
block clears. Plus a config gate (ships OFF), AgentServer wiring, and a read-only `GET /gemini/capacity`
route. Nothing else changes; #708's defer behavior is untouched.

## Decision-point inventory

One decision surface: *whether to raise an attention item*. It is bounded — observe-only, never mutates
the gate, never blocks/retries a call, never auto-recovers. The worst case is an extra attention item;
it cannot affect Gemini call behavior.

## 1. Attention spam

Mitigated three ways: (a) ships OFF by default; (b) per-episode dedup — at most one item per distinct
`deferredUntil` value, so repeated ticks within the same block don't re-raise; (c) the `escalateAfterMinutes`
threshold (default 60) means short, self-healing blips never escalate — only genuinely long blocks do.
The episode key re-arms only when the gate clears (`allow`), so a fresh block warns once more.

## 2. False escalation

The monitor reads the SAME gate #708 uses to refuse calls, so "blocked" is ground truth, not a guess.
`remainingMs` is the gate's own `retryAfterMs`. There is no independent classification that could
disagree with the policy.

## 3. Wiring / cadence

Rides the existing `TokenLedgerPoller.afterTick` alongside the cycle-SLA monitor (awaited in sequence) —
no new timer, no new process. When the poller is idle (no running sessions) the tick still fires on the
poller's idle cadence; a missed tick only delays the escalation, never drops the block.

## 4. Migration / reversibility

Config default added to `ConfigDefaults.ts` → automatic `migrateConfig` parity via `applyDefaults` (no
separate migration block). Default OFF, so existing agents are unaffected until they opt in. Revert =
revert the commits; no persisted state, no schema change.

## Verdict

Observe-only, bounded, default-OFF, reads ground-truth gate state. The only behavioral change when
enabled is one attention item per long Gemini block — strictly more visibility, never less availability.
