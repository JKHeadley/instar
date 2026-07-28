---
title: A tokenless standby skips its local tone gate on a relayed reply (the holder gates it)
slug: standby-skip-local-tone-gate-on-relay
status: approved
review-convergence: 2026-06-01T05:05:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate during the autonomous
  multi-machine proof run (topic 13481, 2026-06-01). Found by code-grounded
  diagnosis of why the standby's /telegram/reply hung >50s before relaying.
  Serves Justin's "robust under degraded conditions" standard. Flagged per
  cross-agent discipline.
---

# Standby skips its local tone gate on a relayed reply

## Problem

The `/telegram/reply` route runs the outbound tone gate
(`checkOutboundMessage` → `MessagingToneGate.review`) on the reply text BEFORE
sending. On a multi-machine pool standby serving a moved session, `sendToTopic`
does not send directly — it RELAYS the reply to the Telegram-owning lease holder,
whose own `/telegram/reply` runs the holder's tone gate again. So the standby
tone-gating the reply is:

1. **Redundant** — the holder (the single Telegram owner) gates the same reply on
   receipt. The reply is already the agent's finalized output.
2. **A pre-relay stall** — `MessagingToneGate.review` makes a serial LLM call
   (`claude -p`), and under the rate-limit-resilience fix that call carries
   `rateLimitWaitMs = 120_000`: when the LLM circuit breaker is open
   (rate-limited), the tone gate WAITS up to 120s before returning — and the
   relay only starts after that. Observed live (2026-06-01): a standby's
   `/telegram/reply` hung >50s before relaying, with the relay's own
   `AbortController` timeout unable to help because the stall is BEFORE the relay
   call.

Net: every cross-machine reply pays a double tone-gate, and under load the
standby's gate can stall the whole reply for up to two minutes before the relay
even begins — exactly the fragility the multi-machine feature must not have.

## Solution

When a server will RELAY the reply (a tokenless standby with `outboundRelay`
wired), skip its LOCAL tone gate. The holder gates it.

- `TelegramAdapter.willRelay(): boolean` — returns the exact `sendToTopic`
  relay-vs-direct branch condition (`!hasUsableBotToken && outboundRelay !==
  null`). A non-empty string token → false (direct send, still gates locally).
- `/telegram/reply` skips `checkOutboundMessage` when `ctx.telegram.willRelay()`
  (alongside the existing `isProxy` / `isSystemTemplate` skips). Direct sends are
  unchanged — they still gate locally.

## Scope

- `src/messaging/TelegramAdapter.ts` — new `willRelay()` method.
- `src/server/routes.ts` — `/telegram/reply` skips the local tone gate when
  `willRelay()`.

## Testing

`tests/unit/telegram-tokenless-relay.test.ts` (+4): `willRelay()` is true for a
`{secret:true}` placeholder + relay wired, true for null token + relay, false for
a real string token, false for tokenless with no relay wired. Regression: 57/57
across TelegramAdapter + MessagingToneGate + relay-timeout suites; `tsc` clean.

## Non-goals / safety

- Does NOT weaken outbound gating: the reply is still gated, by the holder (the
  single Telegram owner). Only the redundant standby-side gate is skipped.
- Direct (non-relay) sends are byte-unchanged — they gate locally exactly as
  before. Single-machine agents never relay, so they are unaffected.
- This pairs with the relay timeout/observability/truthful-success fix
  (v1.3.182): together they bound BOTH the pre-relay path (this) and the relay
  call itself.
