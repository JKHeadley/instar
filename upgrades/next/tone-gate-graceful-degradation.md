# Tone gate degrades gracefully instead of silently cutting you off

## What Changed

The outbound message tone gate (`MessagingToneGate.review()`) used to HOLD every
outbound message when its LLM reviewer was unavailable (provider rate-limited /
circuit breaker open). During a sustained backend outage that turned the safety
gate itself into the outage — the user saw delivery receipts but no replies for
hours. (Postmortem failure F4.)

Now, on a sustained provider-outage, the gate degrades to an in-process
**deterministic leak floor** (the same B1–B7 artifact detectors + internal-id
leak detector, run with NO LLM and NO subprocess): a clean message SENDS, a
message carrying a high-stakes artifact (command, path, config key, endpoint,
internal id) still HOLDS. The same outage has **two manifestations and both
degrade**: the FAST one (the breaker throws inside `review()`) and the SLOW one
(the gate stalls past the outbound route budget — the documented 2026-06-08
failure) — covered via one shared degrade path so the slow stall no longer
silently holds either. The fix distinguishes these dispositions:

- INFRA-unavailable (provider error / breaker open, OR slow-stall budget timeout) → **degrade** to the floor (default).
- CONTENT-unsafe (the model produced a real block verdict) → still **HOLD** (never degraded).
- Host spawn-cap shed (transient capacity) → still **fail-closed** (P3 invariant intact).

Operator override `messaging.toneGate.failClosedOnExhaustion` (governs both the
throw and the budget-timeout paths): `true` restores the strict hold-everything
behavior, `false` is legacy fail-open, unset is the new degrade default.

## What to Tell Your User

During a sustained AI-backend outage you now stay reachable — your clean replies
still go through a fast safety check instead of being silently held, while any
message that would leak a sensitive artifact is still held. You are never again
silently cut off because the message-safety check lost its AI engine.

## Summary of New Capabilities

- The outbound tone gate degrades gracefully when its LLM reviewer is unavailable:
  clean replies still send (via a fast in-process safety scan), leaks still hold.
  Covers both the fast (breaker) and slow (budget-timeout) manifestations of an
  LLM-backend outage, so you are not silently cut off during a rate-limit window.
- New operator control: `messaging.toneGate.failClosedOnExhaustion` is now
  three-valued — unset = degrade (default), `true` = strict hold-everything,
  `false` = legacy fail-open. Read live (no restart).

## Evidence

- Fixes the 2026-06-25 silent-outbound outage (postmortem F4): a rate-limited
  engine opened the circuit breaker and the gate held every message for hours.
- 61 unit tests pass (MessagingToneGate + spawn-cap-fail-closed-gates +
  outbound-gate-budget), covering BOTH paths: provider-throw + clean → sends;
  provider-throw + leak → holds; budget-timeout + clean → sends; budget-timeout +
  leak → holds; capacity-shed → fail-closed; content-block verdict → never
  degraded; all three operator-override values.
- Independent second-pass review concurred and surfaced the slow-path
  (budget-timeout) sibling as a concern — closed in this same change (no deferral)
  rather than shipped partial. The deterministic floor reuses the exact detector
  set the LLM uses and is strictly more conservative (over-blocks, never
  under-blocks); secret values remain handled by the separate unchanged redaction
  pass.
