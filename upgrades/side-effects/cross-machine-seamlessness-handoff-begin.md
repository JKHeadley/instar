# Side-Effects Review — Cross-Machine Seamlessness: handoff begin signal

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3d (converged, approved)

The begin signal the spec's planned-handoff protocol needs but left implicit: the
point-to-point message by which the OUTGOING machine opens a handoff and hands the
INCOMING machine the flush manifest it must echo. Symmetric with the ack/yield routes
already shipped (commit 5fc5a1008). This increment lands the ROUTE SURFACE only; the
incoming HandoffReceiver that consumes it and the outgoing HandoffSentinel that POSTs it
are the next sub-increments (C-receiver, C2 — tracked in docs/SEAMLESSNESS-WIRING-PLAN.md).

## What changed
- `src/server/machineRoutes.ts` — NEW route `POST /api/handoff/begin` (authMiddleware).
  Validates the manifest shape (tailSeq:number + ingressPosition + threadHistoryHash:string;
  topic is carried for the incoming's hash recomputation) and delivers it via `onHandoffBegin`.
  Returns 400 on a malformed manifest, 401 unauthenticated, and 503 when the callback is
  absent (honest not-wired — never a silent ok).
- `src/server/AgentServer.ts` — NEW `onHandoffBegin?` option forwarded into the route mount.
  Absent → the begin route 503s. server.ts will bind it (C-receiver) to store the manifest
  and drive HandoffReceiver.onBeginHandoff.

## Over-block / under-block
- The begin route carries no authority — it only delivers a manifest to the incoming. The
  incoming still attempts NO lease action on begin (it only builds + sends its ack); the lease
  CAS happens solely on the later explicit yield. So a spurious/forged begin (rejected anyway
  by machineAuth) cannot move the lease.
- Manifest validation is shape-only here; the semantic echo-verification (does the incoming's
  ack match what the outgoing flushed?) is the HandoffSentinel's job (§8 G3e), unchanged.

## Signal vs authority
- Pure transport/signal. No role mutation, no lease mutation. The authority (yield → CAS)
  is untouched.

## Interactions
- Same authenticated machine channel (signRequest/machineAuthMiddleware) as
  /api/lease, /api/live-tail, /api/handoff/{ack,yield}. 1:1 with the single peer.
- Consumes nothing new; produces a delivered manifest for the (next-increment) receiver.

## Rollback cost
- Minimal. One additive route + one optional option. Reverting removes them with no behavior
  change (the route 503s today since server.ts does not yet supply the callback).

## Tests
- `tests/integration/machine-routes.test.ts` (+3): a valid signed begin → onHandoffBegin with
  the manifest + machine id; a malformed manifest → 400 (callback never fires); unauthenticated
  → 401; plus the unwired route → 503 (extended the honest-503 case). 23/23.
- `tests/e2e/multi-machine-http.test.ts` (+1, feature-is-alive): a signed begin POSTed from
  machine B reaches machine A's onHandoffBegin through the real booted server. 13/13. tsc clean.
