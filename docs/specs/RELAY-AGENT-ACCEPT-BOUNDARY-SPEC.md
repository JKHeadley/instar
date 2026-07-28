---
title: Respond at the accept boundary on /messages/relay-agent so a slow spawn can't cause a duplicate reply
review-convergence: retrospective-single-pass
approved: true
eli16-overview: RELAY-AGENT-ACCEPT-BOUNDARY.eli16.md
---

# Relay-Agent Accept-Boundary Response (duplicate-reply ROOT fix)

## Problem

The co-located agent-to-agent inbound handler `POST /messages/relay-agent`
(`src/server/routes.ts`) AWAITED `ThreadlineRouter.handleInboundMessage` — a
session spawn/resume that routinely takes 9-30 s — before responding. But the
SENDER, `MessageRouter.relay` (`src/messaging/MessageRouter.ts:494-505`), uses
`AbortSignal.timeout(5000)` and reads only `response.ok`. So whenever the
receiver's spawn outran 5 s, the sender's fetch aborted, it treated delivery as
failed, and it retried (or fell to the drop directory) — and a retry arrived
with a FRESH `message.id`, which slipped past the id-based relay dedup and
caused a second spawn → a DUPLICATE reply.

The content-hash dedup (PR #573) is the symptom backstop — it collapses an
identical retry. This spec removes the ROOT: the receiver should not make the
sender wait on a 9-30 s spawn behind a 5 s timeout.

History: the original handler fire-and-forgot the router and returned `{ok:true}`
immediately. PR-1 ("stop lying about delivery") made it AWAIT and return the
spawn result, so callers could learn the outcome. But no caller's CORRECTNESS
depends on the synchronous outcome — `MessageRouter.relay` reads only
`response.ok`, and the actual reply flows back via the reply-waiter mechanism,
decoupled from this HTTP response. The one place the outcome fields ARE read —
the `/threadline/relay-send` local fast-path (`routes.ts:13824-13835`) — uses
them only to build an informational `deliveryOutcome` string, which now degrades
gracefully to the existing `'accepted'` default (no retry/delivery/correctness
impact; `delivered` stays `true`). So PR-1 traded the duplicate-reply root for an
outcome that only feeds an observability string.

## Fix

Respond at the ACCEPT BOUNDARY. The message is already accepted into the inbox
(`messageRouter.relay`) and has passed the warrants-reply gate by the time we
reach the router block, so we respond `{ ok: true, accepted: true, threadline:
{ accepted: true, async: true } }` immediately and run
`handleInboundMessage(envelope)` in the background (`void` + `.then`/`.catch`
logging). The handler is NOT dropped; its outcome is logged; a rejection can't
500 a response that already returned.

What is preserved, unchanged and still synchronous (all fast, all before the
response):
- the content-hash dedup short-circuit,
- the reply-waiter resolution (delivers a reply to a waiting sender),
- the warrants-reply gate (suppress → `{suppressed:true}` short-circuit, never
  reaching the spawn).

Only the non-suppressed spawn path changes: sync-spawn-result → async-spawn +
accept-ack.

## Scope

This spec covers ONLY the co-located path (`/messages/relay-agent`) — the
confirmed bug (the same-machine echo↔codey loop, `MessageRouter.relay`'s 5 s
timeout). The relay-FUNNEL path
(`ThreadlineEndpoints` `/threadline/messages/receive`) has the same blocking
shape but DIFFERENT error semantics (a `422`-retryable response on
`result.error`) that an accept-boundary conversion must redesign — a distinct
change with its own design, tracked in issue-580. <!-- tracked: issue-580 -->
It is not part of this PR (which is complete on its own terms: it fully fixes
the co-located duplicate-reply root).

## Signal vs authority

No new authority. The handler already DECIDED to accept (relay) and to reply
(gate) before this point; the change is only WHEN it responds relative to the
background spawn. Nothing is gated, blocked, or filtered differently.

## Testing

- **Integration** (`threadline-relay-agent-result.test.ts`, rewritten): the
  response is `{accepted:true, async:true}` WITHOUT the spawn fields; it returns
  BEFORE a deliberately-held handler finishes (router-start present, router-end
  not — proving we did not await); the handler still runs to completion in the
  background; a background rejection still yields 200 accepted; the reply-waiter
  tests (resolution before the response) are unchanged and green.
- **Regression**: the content-hash dedup suite + the keystone wiring test
  (gate-runs-before-spawn, made formatting-robust) stay green.

## Rollback

Revert the one `routes.ts` block (re-await + return the result) and the test.
No data, no migration. The content-hash dedup remains as the symptom backstop
regardless.

## Authority note

Shipped under the 12-hour session deploy mandate; `approved:true` self-applied,
flagged in the PR. Justin explicitly asked to "move forward with the
duplicate-reply fix." Grounded by reading the sole co-located sender
(`MessageRouter.relay`) and confirming it reads only `response.ok` within a 5 s
timeout — so the accept-boundary breaks no consumer.
