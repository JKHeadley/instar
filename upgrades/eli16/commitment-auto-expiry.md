# ELI16 — Commitment Auto-Expiry

## What Changed

The commitment tracker now has a quiet cleanup loop for old agent-owned commitments. If an agent promised to follow up, the promise stayed open forever unless another part of the system explicitly closed it. That was fine when there were a few commitments, but the live store now has hundreds of stale agent-owned rows that were probably completed weeks ago and never marked closed. The result is a backlog where the important current promises are mixed with old noise.

This change adds `commitments.autoExpiry`, enabled by default but shipped in `dryRun: true`. The default policy is simple: after 21 days, an open agent-owned commitment with no future hard deadline is eligible to move to the existing terminal `expired` state. User-owned commitments are never touched. Young commitments are never touched. A commitment with an unmet future hard deadline is never touched.

## Why It Is Safe

The cleanup uses the existing terminal status instead of inventing a new lifecycle. The sweep is bounded to 500 commitments per pass and uses the tracker's existing batched-save discipline, so a large first cleanup does not write the whole commitments file once per row. In dry-run mode it only logs the aggregate count it would expire.

The rollout is deliberately conservative. Existing agents receive the config defaults through the normal add-missing migration path, but `dryRun` remains true until an operator flips it. That means the first release proves the candidates and log shape before any live store mutation happens.

## How To Verify

The focused tests create old and young commitments, agent-owned and user-owned commitments, and future-deadline commitments. Only the old agent-owned open row expires. The dry-run test proves the row is not mutated. The idempotency test proves a second sweep over the same state changes zero rows. The write-coalescing test proves twelve expirations produce exactly one commitments-store write for the sweep.

Integration and e2e tests reload the tracker and hit the commitments API after expiry. The expired record is still inspectable, but it disappears from the active commitment view.
