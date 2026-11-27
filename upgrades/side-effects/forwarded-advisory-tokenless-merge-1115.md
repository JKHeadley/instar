# Side-Effects Review — 3114 merged with 3095: forwarded advisory answers on a token-less machine (2026-11-15)

**Version / slug:** `forwarded-advisory-tokenless-merge-1115`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `not required (merge of two reviewed features; one combined branch)`

## Summary of the change

PR #3095 (token-less standby forward, merged) and this PR (#3114, forwarded advisory answers) both changed the start of `forwardReplyToHolder` in `src/messaging/telegram-origin/OriginForwardToHolder.ts`, and both added declarations to `types.ts`.

The merge keeps both:
- On a `self` settle, a machine WITH a token still sends locally. A token-less machine does not, because it has no transport (#3095).
- An advisory replacement goes to `forwardAdvisoryAnswer` (#3114). On a token-less `self` settle that function has no holder (`settled.kind !== 'peer'`), so it records a held operation with reason `not-attempted` and sends nothing. This matches #3095's rule that a token-less `self` settle is a hold, never a local send.
- `types.ts` keeps both `AdvisoryAnswerClosedError` and the relay pre-prepare declarations.

## Decision-point inventory

The token-less `self` settle combined with an advisory replacement is the one new combination. It resolves to "held". It does not send, and it does not return "local".

## 1. Over-block

No issue identified. Machines with a token behave as before.

## 2. Under-block

No issue identified. A token-less machine never sends locally on either path.

## 3. Level-of-abstraction fit

Each feature's existing function decides its own case.

## 4. Signal vs authority compliance

Unchanged.

## 5. Interactions

A held advisory answer on a token-less machine goes through the advisory store's existing held and expiry handling.

## 6. External surfaces

None.

## 7. Rollback cost

Revert the merge commit.

## Tests

- forwarded-advisory, forwarded-advisory migration, forwarded-delivery-history, tokenless-durable-forward and tokenless-held-debt: 5 files, 67 of 67 pass.
- tsc is clean.
