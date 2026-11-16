# Side-Effects Review — 3095: prior shipped relay script SHA, and the topic name in the gone-machine notice (2026-11-15)

**Version / slug:** `standby-forward-shipped-sha-topicref-1115`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `not required (an upgrade-list entry and a notice wording helper)`

## Summary of the change

Local Verify failed PR #3095 on two guard tests:
- `lint-template-sha-history`: this PR changes `src/templates/scripts/telegram-reply.sh`, so the version now on main (sha256 `9d389203…ea79`, shipped with #3092) must be listed in `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS`. Without it, agents carrying that script are not upgraded. The fix adds the hash with a comment.
- `topic-ref-ratchet`: the new gone-machine held-reply notice in `AgentServer.ts` rendered a bare `topic ${id}`. It now uses `topicRef(id)`, which gives the verified topic name or "(name unresolved)".

## Decision-point inventory

The upgrade check `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS.has(existingSha)` now recognises one more known shipped version, which is the check's intended use. No other decision changes.

## 1. Over-block

No issue identified.

## 2. Under-block

No issue identified. The only hash added is one this repository actually shipped. Hand-edited scripts are still left alone.

## 3. Level-of-abstraction fit

Both fixes use the existing mechanisms (the shipped-SHA set, `topicRef`).

## 4. Signal vs authority compliance

Not applicable.

## 5. Interactions

Agents on the #3092 script are upgraded to this PR's script on update, which is the intended path. The notice text gains the topic name.

## 6. External surfaces

Notice wording only: "to topic 123" becomes "to topic 123 "name"".

## 7. Rollback cost

Revert the two lines.

## Tests

- `lint-template-sha-history` and `topic-ref-ratchet` pass, along with 2 tokenless-forward unit files (4 files, 39 of 39).
- tsc is clean.
