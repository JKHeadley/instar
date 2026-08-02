<!-- bump: minor -->

## What Changed

Instar now has bounded reach for pending high- and critical-priority evolution
actions that have no due date. The development agent exercises the production
selection, durable ledger, stable-owner-plus-lease gate, and metrics in dry-run mode by default;
other agents remain dark until explicitly enabled.

Each live pass can surface at most one action. A durable four-hour global cadence,
14-day per-action cooldown, three-raise disposition terminal, stable delivery id,
three-attempt retry cap, and 4 MiB ledger ceiling prevent restarts, overlapping
passes, transport failures, and storage growth from turning the feature into a
notification or retry flood.

## What to Tell Your User

Important actions without honest due dates now have a bounded path back into view.
Instar can bring one old, high-priority action back for review at a controlled pace
without changing, completing, or cancelling the action on its own. Eventual reach
still depends on the scheduler running and arrivals staying below the service rate.

## Summary of New Capabilities

- Deterministically selects one oldest eligible action through balanced critical
  and high-priority lanes, including actions with an explicit no-date reason.
- Persists cooldown, delivery, outcome, retry, and terminal-disposition evidence
  across restarts.
- Exposes a health read and a bounded manual pass through the existing evolution
  action service.
- On a multi-machine agent, requires every registered peer's latest authenticated
  advert to agree on one stable owner, and pauses during a handoff away from it
  instead of resetting history.
- Records whether a surfaced action changed state after one cooldown period.
- Ships development-live but dry-run-first; live Attention delivery requires an
  explicit rollout decision.

## Evidence

- Unit coverage pins lane weighting, age override, cooldown, explicit opt-out
  reach, reset, retirement, retries, cadence reconstruction, and terminal state.
- Integration coverage pins the read/run routes, real Attention dedupe behavior,
  and the on-disk growth ceiling.
- Lifecycle coverage boots the real server path, reads the real action store, and
  proves delegation to the production Attention seam; live transport evidence is
  deliberately left to the dark → dry-run → live rollout gate.
- The self-action convergence ratchet models the durable four-hour rate floor
  across repeated reconstruction.
