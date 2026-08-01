# Side-effect review — PromiseBeacon user output off by default

## Changed boundary

`PromiseBeacon` now has one absolute human-output authority:
`userOutputEnabled === true`. The check runs before direct conversation sends,
ambiguous retries, owner routing, aggregate creation/flush, and every
PromiseBeacon Attention path. Missing or false configuration suppresses output.

## Expected effects

- New and upgraded agents stop automated PromiseBeacon topic and Slack summaries.
- Close-outs, Rung-2 statuses, Rung-3 Attention, delivery dead-letters, and
  external-block Attention are also silent by default.
- Commitment cadence, overdue/session-loss detection, revival, escalation
  transitions, and audit events continue internally.
- The disabled path does not capture terminal output or spend LLM budget to
  manufacture a summary that will never be shown.
- Old durable aggregate batches are retired through the same typed suppression
  result rather than leaking after an update.

## Persistence and migration

The add-missing defaults path and the v3 honest-progress migration write
`promiseBeacon.userOutputEnabled: false` into existing configurations without
overwriting an explicit `true`. The production constructor also uses a strict
equality check, so a missing key is silent before any migration write occurs.
Generated and migrated framework instructions carry the same default-silent
contract.

## Failure behavior

- A failed internal cadence bookkeeping write emits an internal event and
  re-arms the timer instead of permanently disarming follow-through.
- A suppressed external-block Attention item is not stamped as user-visible,
  preserving eligibility if a deployment later opts in.
- Explicit opt-in preserves the historical output behavior and existing test
  coverage.

## Class-closure declaration

This closes an unbounded-self-action notification class at the outermost output
boundary: under indefinitely pending commitments, the default configuration now
converges to zero PromiseBeacon human-facing actions. The focused default-off
test exercises conversation, Attention, external dead-letter, cadence, LLM,
migration, and production-wiring seams.
