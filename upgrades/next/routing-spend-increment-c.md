# Routing Control Room — Increment C: the alert layer (dryRun-first, live on dev agents)

**Spec:** `docs/specs/routing-control-room-spend-alerts.md` (converged r7 + approved, parent-principle: Token-Audit Completeness)
**Side-effects:** `upgrades/side-effects/routing-spend-increment-c.md`
**Maturity:** ⚗️ Experimental — `routingSpend.alerts.enabled` rides the dev-agent gate (dark on the fleet), and `alerts.dryRun` defaults TRUE even on dev: decisions are audited, nothing is delivered, until a deliberate flip (FD-16).

## What Changed

- **`SpendAlertDispatcher`** (`src/core/SpendAlertDispatcher.ts`): lane-scoped dedup (money-critical
  cap-hit/holder-dead vs informational — S-F8) + informational coalescing into ONE digest per window
  + edge latch on CONFIRMED delivery only + dryRun-first + the scrubbed
  `logs/routing-spend-alerts.jsonl` audit (metadata only — S-F7).
- **`TelegramSpendTopicChannel`** (`src/core/TelegramSpendTopicChannel.ts`): message-INTO the ONE
  "💰 Routing & Spend Alerts" topic; money-critical kinds prefer the DURABLE relay
  (`PendingRelayStore` → `DeliveryFailureSentinel`, retry-until-delivered); lifeline fallback on ANY
  failure; a repoint of `alerts.telegramTopicId` is audible in BOTH topics (G5).
- **`SpendAlertEmitters`** (`src/core/SpendAlertEmitters.ts`): cap-approach 50/80% on BOTH caps (G4),
  cap-hit on gate refusal (A-Min13 wording), door-dark with P19 brakes (episode budget = chain
  length, widening backoff, flapping escalation), fallback-spike only at the hourly ceiling crossing
  (Near-Silent), holder-dead surviving-voice (A2-2, stable pool-wide key), recon-drift surface
  (fed by the Layer-1c sweep, next PR).
- **Resolver rung 2 pool half (FD-6):** the created topic id is published as a content-free
  `routingSpendAlertTopicId` field on the replicated machine registry
  (`MachineIdentityManager.updateRoutingSpendAlertTopic` / `readAnyRoutingSpendAlertTopic`) — a
  future serving-lease holder INHERITS the id instead of re-creating; a degraded registry read
  falls through the lease-fenced ladder (never a duplicate mint).
- **Router fan-out (I-9):** `onNatureRoutePlan` now fans to the env-gated console breadcrumb + the
  emitters with per-subscriber throw-swallow; served fallbacks are counted from the existing
  `onDegrade` seam.
- **Gate observer:** `MeteredSpendGate` gains an OPTIONAL signal-only `onGateEvent` (admit +
  cap-exceeded refusal), throw-swallowed — the admit/refuse path is unchanged (unit-pinned).
- Self-action convergence models for the three new notifiers; config keys
  `routingSpend.alerts.enabled` / `alerts.dryRun`.

## Evidence

- `tests/unit/spend-alert-dispatcher.test.ts` — lanes, dryRun default, coalescing, edge latch
  (confirmed-only), digest-failure un-latch, channel isolation, durable-relay preference, lifeline
  fallback, G5 repoint, rung-2 pool inherit/publish/degraded-read.
- `tests/unit/spend-alert-emitters.test.ts` — the full trigger matrix + P19 brakes + observer isolation.
- `tests/integration/spend-alert-pipeline.test.ts` — the assembled pipeline: dryRun soak, durable
  relay into the resolver-created topic, digest delivery, lifeline degradation.
- `tests/e2e/routing-spend-lifecycle.test.ts` — the alert layer constructs on the REAL AgentServer
  boot path on a dev agent (dryRun-first pinned) and stays DARK on the fleet.
- `tests/unit/self-action-convergence.test.ts` — 47/47 with the three new models.

## What to Tell Your User

Nothing yet — the alert layer ships in dry-run soak: it decides and audits but delivers nothing.
Once flipped live (after the soak), every routing/spend notice — cap warnings at 50/80%, cap hits,
a routing chain going fully dark, fallback-rate spikes — will land in exactly ONE "💰 Routing &
Spend Alerts" Telegram topic (never a new topic per event), with only genuinely money-critical
items escalating immediately and everything else coalesced into a quiet digest.

## Summary of New Capabilities

- (⚗️ Experimental, dryRun soak) The one-topic spend/routing alert layer: lane-deduped, digest-
  coalesced, durable-delivery for money-critical kinds, pool-durable topic identity. Layer 1c
  provider reconciliation (which feeds the drift alert) and the operator's amortized-subscription
  display land next in this train (tracked: CMT-1929).
