# Side-Effects Review — Telegram pre-POST delivery-id mint + 409 Arm C

**Version / slug:** `slack-outbound-robustness-telegram-prepost-mint`
**Date:** `2026-07-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Two coupled fixes to the DEPLOYED Telegram reply script (spec §2.6 round-3 C1 + R8-M1 Arm C):

1. **Pre-POST delivery-id mint (the latent double-post fix, task 2).** The deployed `telegram-reply.sh` mints the `delivery_id` at ENQUEUE time — i.e. only AFTER the first POST already failed — so the FIRST send is permanently outside the id-ledger guarantee. If the initial POST is accepted server-side but the response is lost to the script, the script enqueues under a FRESH id and a redrive past the content-dedup window re-POSTs the same message under an id the server never recorded → double-post. The fix mints the UUID BEFORE the initial POST and sends it as `X-Instar-DeliveryId` on the initial send; the server records THAT id the moment the send lands (the route already reads + records the header), and the enqueue reuses the exact same id + a mint-time `attempted_at`, so every redrive of that row is answered `idempotent:true`.
2. **409 delivery-in-flight → NON-LOSING (Arm C).** The classifier gains a 409 branch: a structured `{ "error": "delivery-in-flight" }` (the §2.4 single-flight reservation race) is RECOVERABLE — enqueued under the same pre-minted id so the sentinel redrives and converges to idempotent. An UNSTRUCTURED 409 stays terminal (default-deny), matching `recovery-policy`'s deployed direction.

**Migration Parity:** the current shipped `telegram-reply.sh` SHA (`63ca933e…`) is added to `PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` so deployed agents cleanly upgrade to the pre-POST-mint template on update (rather than getting a `.new` candidate).

Files touched: `src/templates/scripts/telegram-reply.sh`, `src/core/PostUpdateMigrator.ts` (SHA-history entry), `tests/unit/telegram-reply-prepost-mint.test.ts`.

## Decision-point inventory

- `pre-POST DELIVERY_ID mint + ATTEMPTED_AT` — move — from inside the enqueue block to before the initial `curl`. A mint failure (python3 gone) degrades to a headerless send (fail toward delivery) and, on a later recoverable failure, skips the enqueue with the loud note (today's degraded behavior).
- `X-Instar-DeliveryId` on the initial curl — add — only when a mint succeeded.
- `409` classifier branch — add — structured `delivery-in-flight` → recoverable; unstructured → terminal.
- `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` — add one entry — migration parity for the template change.

## 1. Over-block

None. The initial send is unchanged except for one extra header; a mint failure keeps today's headerless send. No legitimate send is newly refused. An unstructured 409 stays terminal exactly as an unstructured 4xx does today (the script had no 409 branch, so a 409 previously fell to the terminal `else` — behavior preserved for the unstructured case).

## 2. Under-block

`--max-time` on the initial curl (the §2.6 wedged-script gap + the round-7 phase-aware exit-28 classification) is NOT added in this increment — the deployed initial curl has no `--max-time` today, so this change keeps that exact behavior (a hang is a hang, as today) and only strictly improves the first-send id coverage. The exit-28 phase-aware split is tracked as remaining §2.6 machinery. A pre-POST mint failure still leaves the first send outside the ledger (headerless) — the honest, named degradation, identical to today's queue-write-skip.

## 3. Level-of-abstraction fit

Yes. The delivery-id lifecycle belongs in the reply script (Layer 1) that owns the send; the route already reads + records the header. Moving the mint earlier in the SAME script is the minimal, correct place.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — a shell classifier that keys on an exact structured error code (`delivery-in-flight`) and a header add. It never withholds a message; it relaxes the never-seen-a-409 default toward the loss-free recoverable direction only for the exact structured code.

## 5. Interactions

The pre-POST id composes with the deployed `/telegram/reply` X-Instar-DeliveryId LRU (records the id on the first successful send → a redrive is idempotent). The 409 branch composes with R8-M1 Arm A (`recovery-policy` retries structured 409). The enqueue's reuse of the pre-minted id is what makes the sentinel's redrive idempotent rather than a fresh double-post. Existing telegram-reply tests (advisory preflight, end-to-end enqueue, --max-time clamp) all still pass.

## 6. External surfaces

No new route/config/env/CLI. One new outbound header on the initial `/telegram/reply` POST (`X-Instar-DeliveryId`), which the route already handles. One migration SHA entry.

## 6b. Operator-surface quality

No operator-facing surface changes.

## 7. Multi-machine posture

The delivery-id + queue are machine-local by design (the failure and its retry belong to the machine that owns the socket). No cross-machine state introduced.

## 8. Rollback cost

Low: revert the script edits + the SHA entry + the test. A rolled-back binary mints at enqueue again (the deployed latent-double-post behavior). The migration SHA entry is additive and harmless if left.

## Conclusion

Closes the latent Telegram double-post window (delivery-id minted too late to cover the first attempt) by minting pre-POST and reusing the id at enqueue, and classifies the reservation-race 409 as non-losing — both under the Testing Integrity Standard with a real-script test, and with Migration Parity for the template change.

## Second-pass review (if required)

Not required — script-side classifier + header add + migration SHA, fail-toward-delivery, reversible, tested against the real shipped script.

## Evidence pointers

- `src/templates/scripts/telegram-reply.sh` — pre-POST mint, `X-Instar-DeliveryId` header, 409 branch, mint-time `attempted_at`.
- `src/core/PostUpdateMigrator.ts` — `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` entry `63ca933e…`.
- `tests/unit/telegram-reply-prepost-mint.test.ts` — header-on-initial-send / same-id-enqueue / 409-in-flight-recoverable / 409-unstructured-terminal.
- `docs/specs/slack-outbound-robustness.md` §2.6, R8-M1 Arm C.

## Class-Closure Declaration (display-only mirror)

Class: delivery-id-covers-first-attempt (the mint-timing double-post window) on the Telegram lane, plus the 409 member of the R8-M1 status class on the Telegram script. The Slack lane's equivalent (route idempotency + slack-reply.sh pre-POST mint + 409) closes in its own increment.
