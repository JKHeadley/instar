# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Slack outbound delivery robustness (roadmap Phase 2.1) — the first build increments of the converged `docs/specs/slack-outbound-robustness.md`, hardening the Slack (and, where it shares code, Telegram) outbound reply path.

- **R8-M1 status composition (the accepted build residual), all three arms:**
  - **Arm A** (already landed): the pure `recovery-policy` classifies a structured `409 delivery-in-flight` as retry-at-backoff, not the generic `4xx → escalate` (which would terminalize a deliverable message and fire a spurious escalation).
  - **Arm B**: `/slack/reply` now bounds the outbound adapter send with a timeout strictly below the reservation TTL and maps a send TIMEOUT to an ambiguous `408`, never the `500` catch-all. A `500` was classified as retry → the sentinel redrove → the message double-posted.
  - **Arm C**: both reply scripts (`slack-reply.sh`, `telegram-reply.sh`) classify a structured `409 delivery-in-flight` as NON-LOSING — never a blind re-send (double-post), never a silent drop.
- **Latent double-post fix (both channels):** the reply scripts minted the delivery-id at ENQUEUE time — AFTER the first send already failed — so the very first send attempt was outside the idempotency guarantee. An accepted-but-response-lost first send re-posted the same message under an id the server had never seen. The scripts now mint the delivery-id BEFORE the first POST and send it as `X-Instar-DeliveryId` on the initial send; `/slack/reply` reads and records it (mirroring `/telegram/reply`), so a redrive of that send is answered idempotent instead of double-posting.
- **`/internal/slack-forward` typed refusal:** the route's only deployed semantic was an echo bug (posting inbound user text back out) with zero live callers. It now refuses with `409 misdirected-route` and raises one deduped breadcrumb per boot; the real inbound re-point is Phase 2.2.

Migration Parity: the reply-script template changes ship to already-deployed agents via the `PostUpdateMigrator` SHA-history entry (Telegram) and a new feature marker (Slack). Ships dark/internal — no fleet behavior flips on.

## What to Tell Your User

- **Slack replies are getting the same delivery hardening Telegram already has**: "I'm closing a gap where, if a Slack reply's network hiccuped at the wrong moment, the same message could go out twice — now it lands exactly once." This is internal plumbing rolling out quietly; nothing for you to turn on.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Slack reply delivery-id idempotency | automatic (a repeat send under the same id is answered idempotent, never re-posted) |
| Adapter-send timeout classified ambiguous, not a server error | automatic |
| Reply-script 409 delivery-in-flight handled as non-losing | automatic (both Slack and Telegram reply scripts) |
| `/internal/slack-forward` fenced off until Phase 2.2 | automatic (typed refusal) |

## Evidence

Not reproducible in dev without a live Slack workspace plus a mid-send network partition — the end-to-end live proof is the roadmap clause run on the dev agent (spec §7 "Live proof"): kill the network mid-reply, confirm the message arrives exactly once with a recovery audit row, and a manual re-POST of the same delivery-id returns idempotent.

The specific failure modes are closed by deterministic semantic tests that a future reader can re-run:

- Double-post via mint-timing: `tests/unit/telegram-reply-prepost-mint.test.ts` (`enqueues a recoverable 5xx under the SAME pre-minted id`) and `tests/unit/slack-reply-delivery-id-script.test.ts` (`sends X-Instar-DeliveryId on the POST`) assert the id is minted before the first send and reused — the id the deployed scripts left un-covered on the first attempt.
- Double-post via 500-on-timeout: `tests/integration/slack-reply-adapter-timeout.test.ts` asserts a send timeout maps to `408` (finalize-ambiguous, never re-posted), not `500` (retry → double-post).
- 409 non-losing: `tests/unit/recovery-policy.test.ts` (Arm A table cases) + the two script tests assert structured `delivery-in-flight` is retried/non-losing while an unstructured 409 stays terminal.
- Route idempotency: `tests/integration/slack-reply-delivery-id.test.ts` asserts a repeat same-id POST does not re-send and a FAILED first send does not poison the id (its retry still delivers).

All named tests pass (`vitest run`), and `tsc --noEmit` is clean.
