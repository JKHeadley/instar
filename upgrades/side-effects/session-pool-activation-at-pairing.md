# Side-Effects Review — sharing turns on at the first pairing

**Version / slug:** `session-pool-activation-at-pairing`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** gpt-6-astra via codex. Spec: three rounds, findings nine, seven, one, stopped by proportion. Code: two rounds; round one raised two P1s (a dead peer's record refused local delivery; a re-pair overwrote the joiner's later choices), both fixed, round two concurred.

## Summary of the change

A new agent's first pairing now turns sharing on with ceiling `shadow`. The inviter decides before storing the joiner, both machines write one key list, the bot token travels sealed in the pairing response, and the inviter restarts once. A pool started this way earns `shadow` from a held readiness report, loses it after a day without renewal or with no peer, and keeps routing to a live peer when dark.

## Decision-point inventory

- First-pairing activation — add — `decidePairActivation`.
- Stage-0 green from readiness — add — `PairGreenProducer`, marked pools only.
- `shadow` admission and expiry — modify — `StageAdvancer.shadowProof`, marked pools only.
- Routing at dark — add — `_routesToPeerAtDark` and `routingOnly`, marked pools only.

---

## 1. Over-block

Activation declines for any non-default pool setting, so an owner with a stray value gets no automatic sharing. The readiness report says why, and turning it on by hand still works.

## 2. Under-block

An owner who wrote `enabled:false` looks the same as the shipped default, so a first pairing turns sharing on for them. `autoActivate:false` is the real opt-out, and the template says so.

## 3. Level-of-abstraction fit

The decision and key list are pure and live in one module. `StageAdvancer` stays the only stage writer. The route and join call in; they hold no policy.

## 4. Signal vs authority compliance

This is the first time the readiness report has authority: it earns `shadow`. That is deliberate and limited. It cannot pass the ceiling, cannot be written over a real red of this build, and expires.

## 5. Interactions

The inviter restarts once, using the existing flag. Paid routing would self-fence with the pool on, so activation declines when the money layer is on. `pollFollowsLease` goes live on both machines, so the standby holds its poll at boot (#2759).

## 6. External surfaces

`/api/pair` gains two optional response fields. Older joiners ignore them; older inviters omit them. The bot token is sealed to the joiner's key and never appears in clear in the response or in the joiner's config.

## 7. Multi-machine posture

This is the feature. Only the bot token moves; broader secret sync stays off. Both machines hold the same keys, and every new runtime behaviour is gated on the marker, so existing pools do not change.

## 8. Rollback

`multiMachine.sessionPool.enabled:false` reads live. Reverting the code leaves plain config.
