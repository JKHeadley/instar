# Side-Effects Review — the rebalance proof sends its check through the lease holder

**Version / slug:** `rebalance-proof-via-holder`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** codex-cli gpt-6-astra; two findings fixed, the third answered in the spec

## Summary of the change

The proof could only pass on the lease holder: a peer's own router cannot forward, so its check came back `queued`. A proof on a peer now hands its nonce to the holder through a new route, which builds the same fixed text. Also from review: a started run that errors always records red, and each step that could hang has a deadline. `src/core/rebalanceProof.ts`, `src/server/routes.ts`, `src/commands/server.ts`, `src/server/CapabilityIndex.ts`.

## Decision-point inventory

- Proof verdict — modify — a holder that is also the target may handle the probe; a started run that errors is red.

---

## 1. Over-block

A slow step past its deadline goes red, which costs a rerun. The move deadline is 120 s against drains measured under a second.

## 2. Under-block

"Exactly one reply" is read across machines that can be read; stated in the spec.

## 3. Level-of-abstraction fit

Right layer: the holder is where real inbound enters, so the probe now takes the real path.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. The verdict is the existing signed record. The route routes a fixed text and decides nothing.

## 5. Interactions

A listed proof topic is required, the nonce must be hex, and no caller words reach a session. A deadline stops the wait, not the move: the planner keeps its slot.

## 6. External surfaces

One Bearer route, `POST /session-pool/rebalance-proof/probe`. A peer on this build proving against a holder on an older build reads `holder-status-404` and goes red, which is honest.

## 7. Multi-machine posture

Proof rows stay machine-local. The probe uses the same holder lookup as `POST /pool/transfer`.

## 8. Rollback cost

Revert the release. Rows are unchanged in shape.
