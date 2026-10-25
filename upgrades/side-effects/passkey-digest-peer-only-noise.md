# Side-Effects Review — passkey digest: peers-only content is empty

**Version / slug:** `passkey-digest-peer-only-noise`
**Date:** `2026-10-23`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see Second-pass review)`

## Summary of the change

`src/core/PasskeyCellHealth.ts` `buildPasskeyHealthDigest`: `body` (and so `empty`) is now derived from the human-actionable lines only (`bodyWithoutPeers`: cells needing a human, pending revokes, Chrome gate failures, suspension). The unobserved-peer line is still appended to the body when there is real content, and still excluded from `buzzHash` as before. A peers-only digest is empty, so `PasskeyDigestLedger.decide` answers `none` (no open item) or `resolve` (open item closes silently). One unit test added.

Tier 1 (declared): one-line logic change in a notifier, no gate, fully reverted by a revert. Size: 1 src file (+5/-1), 1 test file (+11). Effort: no spec review rounds (Tier 1), first commit attempt. Part of CMT-1408 (Attention topic noise: 341 posts in 3 days, ~5 needed the operator).

## Decision-point inventory

One notifier decision: "is there anything in the passkey digest worth posting". Not a gate: it blocks no action or message; it only decides whether a status item is upserted.

## 1. Over-block

The only content no longer posted is a peers-only digest. That line also carries "(enrollment and proofs are paused here until they answer or are excluded)" when the pool is degraded. That pause is a real state, but it follows from peer reachability (a sleeping laptop, a partitioned PC), which the operator cannot act on from the Attention topic and which is reported by the machine/rope health surfaces and the Machines dashboard tab. `GET /passkeys/health` still returns the digest preview with `counts.unobservedPeers`, so the state stays readable. When any passkey cell needs a human, the peer line is still included.

## 2. Under-block

Unchanged: security events, suspensions, degraded/rejected cells, pending revokes and Chrome gate failures still post with the same buzz/silent rules.

## 3. Level-of-abstraction fit

Right layer: the digest builder owns "what is worth reporting"; the ledger's decide/record logic is untouched. The broader Attention admission rule (CMT-1408) is a separate change.

## 4. Signal vs authority compliance

Compliant. Notification content only; no blocking authority added or removed.

## 5. Interactions

`decide` on an empty digest with an open item returns `resolve`, which closes the hub item silently and resets the ledger, so the next real condition starts a new episode and buzzes. On first deploy, any open peers-only item resolves once (one silent DONE update). The `force` path in routes only upserts a non-empty digest, so it no longer re-posts peers-only content either.

## 6. External surfaces

Fewer Attention-topic posts. No API shape change: `/passkeys/health` and the tick result keep the same fields (`empty` is now true for peers-only content).

## 7. Multi-machine posture

Unchanged: the lease holder narrates the pool-wide digest under one key; peers' lines are built the same way on every machine. The builder is pure, so every machine applies the same rule.

## 8. Rollback cost

Revert the commit; patch release. No state migration (the ledger file format is unchanged).

## Second-pass review

Not required (no gate/sentinel/session-lifecycle change); see Decision-point inventory.
