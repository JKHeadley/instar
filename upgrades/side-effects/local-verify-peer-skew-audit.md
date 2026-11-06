# Side-Effects Review — record when a helper machine is skipped for a version mismatch

**Version / slug:** `local-verify-peer-skew-audit`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** not required (audit row only, no decision changed)

## Summary of the change

Tier 1, 2 source files, about 22 source lines, one commit. `LocalVerifyService.dispatchOnce` already skips a peer whose verifier version or policy hash differs. That skip left no trace. It now appends `peer-skipped-skew` once per version change and `peer-skew-cleared` when the peer matches again. Dedupe state is an optional in-memory field on `PeerHealth`.

Why: on 2026-11-06 the M5 peer stopped receiving work at about 13:13Z and the log showed nothing for over four hours. Its update restart was deferred behind live sessions, so its running verifier stayed on an older hash.

## Decision-point inventory

- Peer dispatch admission — pass-through. The skip condition is unchanged, and the new call runs before it and returns nothing.

## 1. Over-block

No issue identified. Nothing new can refuse or delay work.

## 2. Under-block

Rows are written only while `dispatchOnce` reaches the peer: an empty queue, a paused verifier or an open breaker writes nothing, so the row marks the first time a skip mattered, not the moment skew began. A coordinator restart forgets the dedupe key, so one further row appears per restart. Both are acceptable for a signal.

## 3. Level-of-abstraction fit

The coordinator is the only place holding both version pairs at the skip decision. It feeds the existing audit log, which the throughput collector already reads. No parallel check is added.

## 4. Signal vs authority compliance

Compliant. This is a pure signal. Reference: `docs/signal-vs-authority.md`. It holds no blocking authority.

## 5. Interactions

No shadowing or double-firing. The cached status is read, so no extra network call is made. The peer breaker is untouched.

## 6. External surfaces

Two new event names in `logs/local-verify.jsonl`. No route, config, message or user-facing change. Row rate is bounded by version changes.

## 7. Multi-machine posture

Machine-local by design: the row is written by the lease-holding coordinator about its peers, and a new holder starts with no dedupe key and records the skew afresh.

## 8. Rollback cost

Revert the commit. No state, migration or config involved.
