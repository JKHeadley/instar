<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Eradicated the silent-message-loss class from the 2026-07-01 incident, where every
message from the verified operator was silently dropped for most of a day. Three
stacked defects are closed:

- **A refusal now stays a refusal.** The mesh routing layer no longer encodes a
  `sender-rejected` NACK as a successful `forwarded`. It is a first-class terminal
  `RouteOutcome.action:'rejected'`, enumerated into every consumer (live Telegram +
  Slack, the queue drain, `forceReplace`, `isRemotelyHandled`) and into a distinct
  `MessageProcessingLedger` `rejected` terminal. A build-breaking ratchet pins that
  no consumer can ever map a refusal back into a success shape.
- **The user is told.** A terminally-refused user-originated message now produces
  ONE neutral notice on the originating channel ("I got your message but couldn't
  confirm you as an approved sender…") via the deterministic delivery path (never
  the tone gate), deduped per messageId, ceilinged across topics, with a
  flapping-proof decay. The deciding machine writes a metadata-only trace to
  `logs/mesh-rejections.jsonl`.
- **The sanity gate.** Sender re-validation refuses to ARM against a degenerate /
  never-populated / corrupt / operator-unresolvable user registry — it fails toward
  delivery and shouts, using a durable `state/registry-high-water.json` marker to
  tell a fresh-install empty registry (deliver) from an emptied-by-deletion one
  (keep rejecting + alert). Test/fixture identities are refused at the write AND
  load layers, with a dashboard-PIN-minted, load-verifiable signed override for a
  legitimate name-collision, plus a one-time boot migration that quarantines
  already-polluted stores.

Ships always-on (a reachability floor may not be dark). Sender re-validation
remains Telegram-scoped; Slack ships NOTICE parity now (sender re-validation is a
tracked follow-up). Two tracked deferrals: the full ack-vocabulary split
(fb-1e751537-655) and the fixture-clobber/wiring-gate filing (fb-b15ac10b-85c).

## Evidence

- Build: `pnpm build` green.
- Tests (all three tiers): unit `tests/unit/silent-loss-*.test.ts` (route-outcome
  ratchet, ledger `rejected` terminal + redelivery-drop, registry high-water +
  classification taxonomy, sender-validation gate arm/disarm/re-arm,
  test-identity markers + signed allow-marker, UserManager fixture refusal
  write+load, unified notice dedupe/ceiling/decay/divergence, deliver-handler
  onRejected + suppression cache, mesh-rejection log, fixture-quarantine migration,
  CLAUDE.md awareness idempotency); integration
  `tests/integration/silent-loss-refusal-conservation.integration.test.ts` (full
  route→NACK→rejected→ONE deduped notice + metadata trace + gate arm/disarm/re-arm
  + operator-delivered-against-clobbered-registry); e2e
  `tests/e2e/silent-loss-allow-identity-route.test.ts` (PIN-gated mint route
  feature-alive + minted marker survives a real reload).
- Full suite run green before push (Zero-Failure standard).
