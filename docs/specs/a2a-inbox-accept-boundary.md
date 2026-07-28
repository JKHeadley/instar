---
title: Respond at the accept boundary on the /a2a/inbox role-handler hook (third accept-boundary path)
slug: a2a-inbox-accept-boundary
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-plus-adversarial-self-review-2026-05-31
approved: true
approved-by: Echo under the 12h autonomous deploy mandate (self-approved; flagged in PR). Found via the mandate's own-operation watch (a2a delivery to instar-codey timing out in Echo's server-stderr.log).
approval-note: >
  Completes the accept-boundary trilogy: #581 fixed /messages/relay-agent, #3 fixed
  /threadline/messages/receive, this fixes the third synchronous-spawn a2a path — the /a2a/inbox
  role-handler hook (the mentor↔mentee transport). Grounded by tracing the await chain to
  installAgentMessageHook.ts:120 and confirming the reply flows back on a separate channel.
second-pass-required: false
second-pass-status: n/a-mirrors-proven-581-3-pattern-caller-contract-verified
eli16-overview: a2a-inbox-accept-boundary.eli16.md
---

# /a2a/inbox accept-boundary (#45 — third accept-boundary path)

## The bug, grounded

Echo's `server-stderr.log` showed recurring `[a2a] local-inbox delivery attempt failed
(to=instar-codey): The operation was aborted due to timeout`. Tracing it:

- The SENDER (`AgentServer.deliverA2aMessage`) POSTs to the peer's `/a2a/inbox` with
  `AbortSignal.timeout(10_000)` (`AgentServer.ts:1479`) and treats `{agentMessage:true}` as success.
- The RECEIVER's `/a2a/inbox` route (`routes.ts:9888`) `await`s `dispatchAgentMessageHook`, which
  `await`s the agent-message hook (`TelegramAdapter`), which — in `buildAgentMessageHook`
  (`installAgentMessageHook.ts:120`) — did `await handler(msg, …)` before returning `{handled:true}`.
- The registered `mentor` role handler (`AgentServer.ts:1283`) SPAWNS a mentee session and
  bounded-waits for the reply (`sessionTimeoutMs` — minutes), then delivers its reply OUT via a
  SEPARATE a2a message.

So the `/a2a/inbox` response was held for the entire minutes-long spawn+poll, the sender's ~10s
timeout fired, and it logged a FALSE failure — the message was in fact accepted (its id is marked
processed) and the reply arrives on its own channel. (No duplicate spawn: the idempotency mark dedups
any retry, and the sender doesn't re-POST locally — so the harm is the false-failure log + a wasted
10s hold, not duplicates. The accept-boundary is still the correct fix and removes both.)

## Fix

`installAgentMessageHook.ts`: after validating + marking the id processed, respond `{handled:true}`
immediately and run the role handler in the BACKGROUND (`void Promise.resolve().then(() =>
handler(…)).catch(log)`). The handler delivers its reply on its own a2a channel; the HTTP response
never needed it. Mirrors #581 (`/messages/relay-agent`) and #3 (`/threadline/messages/receive`).

## Caller-contract safety
- The sole consumer (`AgentServer.deliverA2aMessage`) reads only `result.agentMessage === true` (the
  ack) within a 10s timeout — it does not depend on the handler having completed. With the fix it
  gets the ack immediately; the reply still flows back as a separate a2a message.
- The idempotency mark (`markProcessed`, before the handler) is unchanged, so a re-delivered id is
  still deduped. The validation/spoof/unknown-role/idempotency early-returns are all unchanged
  (they run before the handler).
- A background handler rejection is caught + logged (it can't reject a response that already
  returned). The id stays marked (same as before — a re-attempt would just re-fail).

## Migration parity
N/A — code-only (`installAgentMessageHook.ts`), compiled into `dist`; ships in the normal release. No
agent-installed file / config / template change → no `PostUpdateMigrator` pass.

## Agent Awareness
N/A — internal a2a-ingress timing.

## Test plan
Unit (`installAgentMessageHook.test.ts`, +2): a slow (held) role handler does NOT block the response
— `{handled:true}` returns immediately (would HANG if it still awaited), the handler runs + completes
in the background, and the id is marked before the async handler; a background handler rejection still
yields `{handled:true}`. The existing HANDLER-ERROR test is updated to tick before asserting the now-
async error log. ROUTE / IDEMPOTENCY / SPOOF / UNKNOWN-ROLE cases stay green.
