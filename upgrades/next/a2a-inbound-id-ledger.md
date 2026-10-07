# Agents remember which messages they already received from other agents

## What Changed

An agent receives agent-to-agent messages on four paths (the relay socket, the relay's unknown-sender path, signed HTTP, and the same-machine route), and each remembered message ids differently — mostly in memory, for ten minutes, and one path re-processed a known id as accepted. Spec: `docs/specs/a2a-inbound-id-ledger.md` (converged, 17 iterations; approved under the operator's standing approval for the agent-comms track).

- New `InboundIdLedger` (own SQLite file `state/a2a-inbound-ids.<agent>.sqlite`, excluded from backups) records every accepted id per sender, written after every gate and before every side effect, with an explicit outcome allowlist. Only a verified `no-reply` row suppresses a resend today; every other resend is delivered again with a fixed "resent copy" notice.
- `InboundMessageGate.setLedgerLookup`: a terminal-row replay is dropped before the rate limiter counts it; the in-memory replay map is used only while the ledger is unavailable.
- `ThreadlineRouter` results gain a `path` field; `MessageRouter` exports `isRelayChainLoop` and a `localMachine` getter.
- `/threadline/health` advertises `capabilities: ['inbound-id-ledger']` and `protocolVersion: 2` while the ledger is operational; new `GET /a2a/inbound-ids` (+ `?scope=pool`).
- HTTP ingress answers an in-flight duplicate with 409 and a database error once with 503, then fails open.
- Sends carry one id on every route and can mark a resend inside the message body.
- Dev-gated (`threadline.inboundIdLedger.enabled` omitted ⇒ live on a development agent, dark on the fleet); CLAUDE.md template + migration section "A2A inbound message-id ledger".

## What to Tell Your User

When another agent sends me the same message twice — for example a copy the relay held while I was offline — I now notice. If the first copy is still being handled, the second waits; if it reached me already, the second arrives clearly marked as a resent copy so I check the conversation before answering. This ships switched on for development agents only while it proves itself.

## Summary of New Capabilities

- `GET /a2a/inbound-ids?sender=<key>&id=<id>[&scope=pool]` — did this machine (or any of my machines) receive message X, and how far did it get?
- `/threadline/health` capability `inbound-id-ledger` for senders.
- Authed `/health` → `threadline.inboundIdLedger` counters.

## Evidence

- `tests/unit/a2a-inbound-id-ledger.test.ts` (56 checks), `tests/unit/threadline/ThreadlineRouter-ledger-path.test.ts` (5), `tests/unit/PostUpdateMigrator-inboundIdLedger.test.ts` (3).
- `tests/integration/threadline/inbound-id-ledger.test.ts` (13): signed HTTP receive and a real AgentServer.
- `tests/e2e/threadline/inbound-id-ledger-alive.test.ts` (4): production controller, real relay, two real servers.
