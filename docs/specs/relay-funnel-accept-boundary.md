---
title: Respond at the accept boundary on /threadline/messages/receive (relay-funnel duplicate-reply root fix)
slug: relay-funnel-accept-boundary
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-plus-adversarial-self-review-2026-05-31
approved: true
approved-by: Justin (Telegram topic 13435, 2026-05-31 08:46Z — "Yes, please proceed. I'll go with your recommendations for all of these")
approval-note: >
  Justin greenlit this from the approved-priorities list (#3 duplicate-reply accept-boundary root
  fix). This completes the issue-580 follow-up that #581 (the co-located accept-boundary) explicitly
  deferred: applying the same proven accept-boundary to the relay-FUNNEL path. Grounded by reading
  the funnel's senders and confirming they read only response.ok within a timeout shorter than the
  spawn — so the 422-retryable path the prior spec worried about is already unreachable.
second-pass-required: false
second-pass-status: n/a-mirrors-proven-581-pattern-caller-contract-verified
eli16-overview: relay-funnel-accept-boundary.eli16.md
---

# Relay-funnel accept-boundary (duplicate-reply ROOT fix, part 2)

## Background — the deferred half of the duplicate-reply root

The duplicate-reply root has two ingress paths. #581 fixed the **co-located** path
(`/messages/relay-agent`) and explicitly deferred the **relay-funnel** path
(`POST /threadline/messages/receive`, `ThreadlineEndpoints.ts`) to issue-580, noting it "has the
same blocking shape but DIFFERENT error semantics (a 422-retryable response on `result.error`) that
an accept-boundary conversion must redesign." This spec is that redesign.

The funnel handler `await`ed `threadlineRouter.handleInboundMessage(envelope)` — a session
spawn/resume that routinely takes 9-30s — before responding. But the funnel's senders
(`MessageRouter` cross-machine relay at `MessageRouter.ts:747` and `AgentBus.httpSend` at
`AgentBus.ts:506`) both read **only `response.ok`** within a **~10s timeout** and fall back to a
durable queue on failure. So whenever the spawn outran ~10s, the sender aborted, treated delivery
as failed, and retried — and a retry arrived with a FRESH nonce/id that slipped past the nonce +
id dedup, causing a second spawn → a DUPLICATE reply.

## The 422-retryable "redesign" turns out to be a non-issue

The error-semantics concern #581 flagged is moot in practice: the senders never **see** the
422. They read only `response.ok` and abort at ~10s — long before the 9-30s spawn produces the
`result.error` → 422. So the 422-retryable path is already unreachable by every real sender; no
caller's correctness depends on the synchronous spawn outcome. (The actual reply flows back via the
decoupled reply-waiter, not this HTTP response — identical to the co-located path.)

## Fix

Respond at the ACCEPT BOUNDARY, mirroring #581. The message is accepted + authenticated +
validated by the time we reach the router call, so we respond
`{ accepted: true, async: true, threadId }` immediately and run `handleInboundMessage(envelope)` in
the background (`void` + `.then`/`.catch` logging). The handler is NOT dropped; its outcome is
logged; a background rejection can't 500 a response that already returned.

Only the spawn timing changes. Auth, payload validation, and the `!threadlineRouter` 503 guard are
unchanged and still synchronous (all before the response).

## Scope decision — accept-boundary only, no new dedup

The accept-boundary removes the **cause** (sender timeout → retry). The content-hash dedup that
#573 added to the co-located path was the SYMPTOM backstop for when the root wasn't fixed; with the
root fixed here, the funnel's retry-source is gone, and the router's existing `pendingSpawns` guard
already blocks concurrent same-thread spawns. So a funnel content-dedup is not needed for the
reported bug and is left out to keep the change minimal. (A shared cross-path content-dedup remains
a possible future hardening, noted as a follow-up — not required here.)

## Residual (documented, matches #581 precedent)

A *genuine* background spawn failure (not a timeout) is now logged rather than surfaced as a
422-retryable response, so it is not redelivered. This is the same trade #581 made for the
co-located path: it is rare, logged, and the reply path is decoupled. Adding durable
requeue-on-genuine-failure for cross-machine is a separate robustness item, not this fix.

## Migration parity

N/A — code-only (`ThreadlineEndpoints.ts`, compiled into `dist`); ships in the normal release. No
agent-installed file, config, or CLAUDE.md template change → no `PostUpdateMigrator` pass.

## Agent Awareness

N/A — internal relay-ingress timing. No new API endpoint, trigger, registry lookup, or building
block to surface.

## Test plan

The behavior is HTTP-route-level (response shape + timing), so the right tier is an integration
test of the route with a held handler (mirrors #581's `threadline-relay-agent-result.test.ts`):
- `ThreadlineEndpoints.test.ts` (extended): with a valid cryptographically-signed receive (real
  handshake + Ed25519 signature) and a mock router whose `handleInboundMessage` is held open, the
  response is `{ accepted: true, async: true, threadId }` WITHOUT spawn fields and returns BEFORE
  the held handler finishes (handler started, not finished — proving we did not await); the handler
  still completes in the background; a background **rejection** still yields 200 accepted.
- Regression: the full threadline suite (ThreadlineRouter, ThreadlineIntegration, the keystone
  gate-before-spawn wiring test) stays green; the funnel's auth tests are unchanged.
