# The same-machine agent route now checks sender trust (watch-only first)

## What Changed

`POST /messages/relay-agent`, the route one agent uses to hand a message straight to another agent on the same machine, handled every sender at trust level `verified` because it never asked the trust manager. The relay gate refuses a sender it holds no trust profile for. (Spec: `docs/specs/a2a-local-route-trust.md`, tracking action ACT-056; approved under the operator's standing approval for the agent-comms track.)

- **The route now resolves the sender's trust** from the same `AgentTrustManager` the relay gate reads and applies the same operation-permission check. Identity order: the fingerprint the registry resolves for the sender name, then the fingerprint stated in the body (only when the registry resolves none), then a profile granted by name. A sender with no profile is `untrusted` and may only `ping` / `health`.
- **Watch-only by default.** With `threadline.localRouteTrust` on, `dryRun` defaults to `true`: every message is delivered exactly as before, and each one that would be refused writes one `[relay-agent-trust] would-refuse …` log line and counts.
- **Enforcing needs `dryRun: false`.** Then a sender that may not perform the operation gets HTTP 403 `{ error: 'insufficient-trust', refused: true, retryable: false, operation }` before the content window reserves and before the inbound-id ledger admits (no ledger row, no inbox entry). An admitted sender is described to the receiving session at its resolved level, never above `verified`.
- **No trust manager wired** (relay off, relay standby, or trust init failed): handled as before and counted.
- **Dev-gated.** `threadline.localRouteTrust.enabled` is omitted (on for a development agent, off on the fleet), read live per request; `false` restores the old behaviour. Counters and the live mode ride the authed `/health` under `threadline.localRouteTrust`. CLAUDE.md template + migration section "A2A local-route trust".

Known limit, stated in the spec: the route cannot prove who the sender is, so a caller that can read this agent's token file and names a trusted peer avoids the refusal. Before this change every caller avoided it.

## What to Tell Your User

Agents on the same computer can hand each other messages directly, and that direct route used to accept any of them without checking whether I trust the sender, even though the relay's check would turn the same sender away. I now check the same trust list on both routes. For now it is in watch-only mode on development agents: nothing is turned away, I only count which messages would be. Before the check is switched on for real, I will add the agents I genuinely work with to my trust list so that working conversations do not stop.

## Summary of New Capabilities

- Same-machine A2A route: sender trust resolved from the trust manager, with the relay gate's operation check.
- `threadline.localRouteTrust: { enabled?, dryRun? }` — dev-gated, dry-run by default.
- Authed `/health` → `threadline.localRouteTrust` (`enabled`, `dryRun`, `trustManagerWired`, `evaluated`, `allowed`, `wouldRefuse`, `refused`, `noTrustManager`, `lookupErrors`).
- Structured pre-admission refusal: HTTP 403 `insufficient-trust` (and a retryable 503 `trust-unavailable` if the lookup fails while enforcing).

## Evidence

- `tests/unit/a2a-local-route-trust.test.ts` (22): the decision against a real `AgentTrustManager`, every level against every operation compared with the relay gate's answer, identity order, mode resolver, log line, migration parity.
- `tests/unit/threadline/ThreadlineRouter.test.ts` (+1): the live-inject grounding states the route-resolved level.
- `tests/integration/threadline/a2a-local-route-trust.test.ts` (15): the real route in every mode; an enforcing refusal leaves no inbox entry, no ledger row and no content window.
- `tests/e2e/threadline/a2a-local-route-trust-alive.test.ts` (4): two real servers booted the production way with a real relay.
