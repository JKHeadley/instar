<!-- bump: patch -->
## What Changed

Fifth piece of the context budget's Phase 2 (shadow folding, still switched off): the cost-versus-savings check, in `src/monitoring/foldBenefit.ts`.

- **`estimateFoldBenefit`** works out whether shrinking a conversation now would save more than it costs. That covers the handoff turn, any re-asks, writing the bundle and the checks, set against the context no longer re-read each turn, priced with the same cost weights the context-budget metrics use. It only recommends asking when the expected remaining turns clear break-even by 1.5×. It prices conservatively on engines that don't report caching.
- **`capOne`** works out how many turns are left before the engine's own automatic compaction. It flags when only one handoff's worth of room remains.

Nothing calls it yet.

## What to Tell Your User

Nothing changes yet. This is the arithmetic that makes sure a conversation is only shrunk when that saves more than it costs.

## Summary of New Capabilities

- None user-visible yet. Internal: the fold benefit estimator and the critical-checkpoint (Cap 1) estimate.

## Evidence

- Unit: `tests/unit/fold-benefit.test.ts` (9) covers warm and cold handoff pricing, cache-blind conservatism on both sides, the 1.5× margin (just over and just under), the no-fold floor, a packet that saves nothing, send-back cost, unknown only for poller lag, and the Cap 1 boundary (critical at exactly one handoff plus one packet write of headroom, never with no growth, unknown inputs unknown).
