---
title: Tokenless-standby reply relay is bounded + observable (timeout + failure logging)
slug: telegram-relay-timeout-observability
status: approved
review-convergence: 2026-06-01T03:35:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate during the autonomous
  multi-machine proof run (topic 13481, 2026-06-01). Justin: "enter autonomous
  mode and continue until we actually get multi-machine functionality fully
  working." Found by driving the live proof — the relay hung and logged nothing.
  Flagged per cross-agent discipline.
---

# Tokenless-standby reply relay: bounded + observable

## Problem

When a multi-machine pool standby serves a moved session, it holds no Telegram
bot token, so `TelegramAdapter.sendToTopic` relays the reply through the
Telegram-owning lease holder's `/telegram/reply/:topicId` (bug #7,
`outboundRelay`, wired in `server.ts`). The original relay had two operational
defects, both found by driving the live multi-machine proof on 2026-06-01:

1. **No timeout.** The relay `fetch` had no `AbortSignal`. When the holder's
   tunnel was momentarily unreachable (observed: the laptop's named tunnel was
   mid-restart), the relay `fetch` hung — the moved session's reply stalled for
   the full client timeout (observed >70s) with no result.
2. **Silent failure.** Every failure path (`no peer URL`, non-2xx, network
   error) returned `null` with no log line. A dropped reply was completely
   invisible — the only way the failure surfaced was driving it live and
   noticing the hang. There was no way to tell *why* a relayed reply didn't
   arrive.

These made the standby→holder reply path both fragile (hangs) and
undiagnosable (silent), which is exactly what stalled the live proof.

## Solution

Extract the relay into a pure, injectable unit `src/core/TelegramRelay.ts`
(`relayOutbound`) and:

- **Bound it**: an `AbortController` aborts the `fetch` after `timeoutMs`
  (default 15s, tunable via `config.multiMachine.relayTimeoutMs`). A stalled
  holder now fails fast instead of hanging the reply.
- **Make it observable**: every non-success path logs one explanatory line —
  `no peer URL for lease holder …`, `holder … returned <status> …`, or
  `relay … FAILED … timeout after Nms` / the network error message. A dropped
  reply is now diagnosable from the log instead of silent.

`server.ts` wires `telegram.outboundRelay` to `relayOutbound(...)` with the live
lease holder, peer-URL resolver, auth token, timeout, and a `pc.yellow` logger.
Behavior on the success path is unchanged (POST the holder, return its
messageId).

## Truthful success (no false "ok" under load)

A third, more dangerous defect surfaced in the same live run: the relay reported
success while the message never landed. Mechanism: the holder's
`/telegram/reply` returned `{ ok: true, topicId }` with **no messageId** (it
discarded the `SendResult` from `sendToTopic`), and the relay returned
`{ messageId: j.messageId ?? 0 }` — a truthy `0` — so the standby's `sendToTopic`
counted it as delivered. Under load this means the system *lies*: "ok" with
nothing delivered.

Fix, two halves:
- The holder's `/telegram/reply` now returns the **real** Telegram `messageId`
  from `sendToTopic` (`res.json({ ok, topicId, messageId })`).
- `relayOutbound` requires a **positive** `messageId` to count as delivered; a
  2xx with a missing/0 messageId is logged and returned as `null` (undelivered),
  so the standby's `sendToTopic` throws and the failure is real + visible (and
  eligible for durable retry) rather than a silent false success.

## Scope

- `src/core/TelegramRelay.ts` (new) — pure `relayOutbound` with injected
  fetch/clock/log; requires a confirmed positive messageId.
- `src/commands/server.ts` — `outboundRelay` now delegates to `relayOutbound`
  (replaces the inline fetch); adds the `relayTimeoutMs` config read + import.
- `src/server/routes.ts` — `/telegram/reply` returns the real `messageId` so the
  relay can confirm delivery (additive field; existing callers unaffected).

## Testing

`tests/unit/telegram-relay-timeout-observability.test.ts` (7) drive the real
`relayOutbound` with an injected fetch + logger:
- 2xx → returns messageId, posts the correct URL + `Bearer` header.
- self-hold → null (no-op).
- no peer URL → null + logs `no peer URL`.
- non-2xx (403) → null + logs the status.
- **holder hangs → aborts within the timeout (elapsed < 2s) + logs `timeout
  after Nms`** (the headline fix — previously unbounded).
- network error → null + logs the error.
- `silent` flag → passed through to the holder body.

## Non-goals

- Does not change the success semantics, the single-Telegram-owner invariant, or
  how the holder's `/telegram/reply` handles the relayed message.
- Does not attempt to fix the *root* network reachability between specific
  machines — it makes that failure fast + visible (the log line now pinpoints
  timeout vs status vs network error), which is the prerequisite for diagnosing
  any remaining holder-side delivery issue.
