---
title: Session-pool inbound dispatch — short-circuit remote placement (no double-dispatch)
slug: session-pool-route-shortcircuit
status: approved
review-convergence: 2026-05-31T10:45:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h deploy mandate (topic 13481).
  Bug #8 of the multi-machine live-transfer cascade, found by running the full
  live "move this to the Mac mini" Telegram test (Justin authorized autonomous
  live testing — see feedback_live_transfer_test_autonomous_authorized). Flagged
  in the PR per cross-agent discipline.
---

# Session-pool inbound dispatch — short-circuit remote placement

## Problem

Found live (2026-05-31) running the full "move this to the Mac mini" transfer on a
throwaway topic. The recognizer fired correctly (pin set to the mini, ownership
released), but the follow-up message was injected into the existing LOCAL laptop
session instead of forwarding to the mini.

Root cause is in the inbound-dispatch call site (`src/commands/server.ts`, the
Telegram `onMessage` handler). When the rollout stage is live it calls
`SessionRouter.route(...)` and only short-circuits local dispatch on
`outcome.action === 'forwarded' || 'duplicate'`. But `SessionRouter.placeAndClaim`
returns **`'spawned'`** when it places + claims a session on a REMOTE machine
(self-placement returns `'handled-locally'`, never `'spawned'`), and
`'owner-dead-replaced'` for either self or remote. A remote `'spawned'` /
`'owner-dead-replaced'` was NOT short-circuited → the message both got spawned on
the target AND fell through to local injection (double-dispatch), so a just-moved
topic kept being served on the origin machine.

A second factor (whether the recognizer's ownership-release propagates, vs the pin
being honored by `PlacementExecutor`) was indistinguishable from the logs because
`route()`'s placement/forward decision was never logged — the live path was a black
box past the recognizer's pin line.

## Goal

When the session pool is live, an inbound message whose routing decision places or
forwards the session onto ANOTHER machine must NOT also be dispatched locally; and
the routing decision must be observable so the remaining cascade (pin-honored vs
ownership-released) can be pinpointed on the next live run.

## Non-goals

- Does NOT fix the standby's missing outbound Telegram (bug #7 — a moved session on
  a tokenless standby still can't reply; tracked separately).
- Does NOT change `SessionRouter.route()` / `PlacementExecutor` decision logic — only
  how the inbound caller INTERPRETS the outcome.
- Does NOT alter the `'dark'` path (still byte-identical to single-machine dispatch).

## Design

1. **Pure helper `isRemotelyHandled(outcome, selfMachineId)`** (exported from
   `SessionRouter.ts`, co-located with `RouteOutcome`): true for `'forwarded'` /
   `'duplicate'` (delivered to a remote owner) and for `'spawned'` /
   `'owner-dead-replaced'` whose resolved `owner` is not self. Pure → unit-testable
   over every `RouteAction` and the self/remote/null-self boundaries.

2. **Call site uses the helper** (`server.ts`): `if (isRemotelyHandled(outcome,
   _meshSelfId)) { …; return; }` replaces the `'forwarded'||'duplicate'`-only check.
   A new module-level `_meshSelfId` (set in the mesh block beside `_sessionRouter`)
   supplies self-identity. Fail-safe: a null self with an unknown owner is treated
   as NOT-remote (falls through to local — never silently drops a message).

3. **Routing-decision log**: one line per routed inbound —
   `[session-pool] route topic N → action=… owner=… self=…` — permanent
   observability for the otherwise-invisible live transfer path.

## Testing

- Tier 1 (`SessionRouter.test.ts`): `isRemotelyHandled` over forwarded/duplicate,
  remote vs self `spawned`, remote vs self `owner-dead-replaced`, local/queued/blocked
  fall-through, and the null-self fail-safe.
- Wiring (`session-pool-activation-wiring.test.ts`): the call site uses
  `isRemotelyHandled(outcome, _meshSelfId)` and still fails safe to local dispatch.
- 50 session-pool tests green; `tsc --noEmit` clean.
- Tier-3: the next live run reads the new route-decision log to confirm the forward
  fires (and to pinpoint pin-vs-ownership for the remaining cascade).

## Migration parity

Pure code (one exported helper + a call-site swap + one module ref + a log). No
config / hook / route / CLAUDE.md change. The pool path is gated past `'dark'`
(default), so existing agents are unaffected until they enable the pool.
