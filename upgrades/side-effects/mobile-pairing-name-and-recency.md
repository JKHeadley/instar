# Side-Effects Review — Pairing link names the agent; device may read topic recency

**Version / slug:** `mobile-pairing-name-and-recency`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`buildPairLink` appends an optional `n=<agent name>` to the link fragment (cleaned with the existing `cleanText`, 40 characters), and the mint route passes `config.projectName`. The device allowlist gains `GET /topic/list` (read-only conversation recency: topic id, name, message count, last activity). Operator feedback from the first live pairing, topic 134088. Tier 1: a display-only link field and one read-only allowlist entry; a revert undoes both.

## Decision-point inventory

- Device allowlist — modify: one read-only route added.

## 1. Over-block

None.

## 2. Under-block

A paired phone can now read the list of conversation names and their last-activity times. It could already read every topic name (`GET /telegram/topics`) and their messages, so this adds only the timestamps.

## 3. Level-of-abstraction fit

The recency already exists in `TopicMemory.listTopics()`; no new store.

## 4. Signal vs authority compliance

`n` is display-only and untrusted: the app labels it as the agent's own name and pairing still binds to the origin and the private code.

## 5. Interactions

Older apps ignore `n` (they read only `v`, `o`, `c`); the instar.sh page parses only those three too.

## 6. External surfaces

The pairing link format gains an optional field (frozen v1 fields unchanged).

## 7. Multi-machine posture

Unchanged: `/topic/list` is this machine's view, like the other device reads.

## 8. Rollback cost

Revert.

## Conclusion

Two small fixes from the first live use.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** No self-triggered action.
