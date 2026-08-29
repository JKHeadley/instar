---
title: Codex Session Delivery Reliability
description: Durable proof that a Codex message was accepted and answered, with fail-closed restart and transfer safety.
---

Sending paste and Enter keystrokes to a terminal proves only that Instar tried
to dispatch a message. It does not prove Codex accepted it. Codex session
delivery reliability records every inbound delivery durably and distinguishes
dispatch, composer clearing, matching-turn consumption, and response.

If a rollout event or composer view is clipped, malformed, resized, or
ambiguous, the result is `unknown`. Instar does not turn absence into success
and does not blindly replay uncertain work.

Inspect the privacy-safe status with:

```bash
curl -H "Authorization: Bearer $AUTH" http://localhost:4040/sessions/inbound-delivery-status
```

The response contains state counts, observer backlog and lag, startup
activation status, breaker state, and uncertain-effect counts. It never
contains message bodies.

## Component map

- `CodexComposerAdapter` reconstructs the complete visible input region.
- `CodexDeliveryObserver` correlates bounded rollout events and composer state.
- `InboundDeliveryStore` owns the FULL-durable delivery and transfer ledger.
- `CodexLifecycleProductionComposition` wires transfer and dark recovery seams
  into the production server.
- `PhysicalEffectLock` and `TrackedPhysicalEffectDispatcher` serialize and
  journal terminal or filesystem mutations across crashes.
- `RecoveryActuationAuthority` is the delivery-scoped, once-only authority for
  future automatic recovery. It remains dark in this release.
- `StageBActivationGate` and `StageBStartupReadiness` require exact signed
  release evidence and prove local durability and lock conformance at restart.
- `FrameworkProcessProvenance` proves a process is the pinned Codex host before
  watchdog policy may treat it as framework infrastructure.

## Rollout safety

The observer activates only when exact release evidence passes the signed Echo
canary gate. Explicit disable always wins. Autonomous refresh or replay remains
separately dark, even when observation is active.
