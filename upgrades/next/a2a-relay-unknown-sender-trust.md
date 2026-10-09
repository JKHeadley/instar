# Relay messages from agents I hold no keys for now check sender trust (watch-only first)

## What Changed

A relay message from a sender whose keys this agent does not hold (the relay's `unknown-sender` path, plaintext) skipped `InboundMessageGate`, was passed on at trust level `verified` (reason `relay-authenticated`) with an automatic ack, and its first message created a fingerprint trust profile at `verified`, `setup-default`. The relay proves key possession, not identity. (Spec: `docs/specs/a2a-relay-unknown-sender-trust.md`, tracking action ACT-066; approved under the operator's standing approval of 2026-10-08 14:49.)

- **The path now resolves the sender's held level** from the same `AgentTrustManager` the gate reads and applies the gate's operation table (`chat` = `message`). Delivery acks pass at every level; `credential-share` never passes this plaintext path; an `untrusted` sender's probe is dropped (the `gate-passed` consumer has no inline probe handler and would route it to a session). Decision logic: `src/threadline/relayUnknownSenderTrust.ts`.
- **Watch-only by default.** With `threadline.relayUnknownSenderTrust` on, `dryRun` defaults to `true`: delivery is exactly as before; each would-refuse writes one `[relay-unknown-sender-trust] would-refuse` line and counts. A profile a stranger's first message writes is created already marked `relayFirstContact: true` and does not count as a grant.
- **Enforcing needs `dryRun: false`.** A refused message is dropped before `gate-passed` (no ack, inbox entry, session or profile); an allowed one carries the held level. A new fingerprint profile starts `untrusted`, and a marked, still-`setup-default` profile reads `untrusted` on the gate path too. Unmarked existing profiles are unchanged.
- **Dev-gated.** `enabled` omitted (on for a development agent, off on the fleet), read live per message. Counters and mode on the authed `/health` under `threadline.relayUnknownSenderTrust`, including `unmarkedSetupDefaultProfiles`. CLAUDE.md template + migration section "A2A relay unknown-sender trust".

## What to Tell Your User

Agents I have never exchanged keys with could message me through the relay, and I treated every one of them as a trusted contact: I replied "got it", could start a full working session for them, and remembered them as trusted from then on. Being able to use the relay only proves an agent holds its own key, not that anyone decided to trust it. I now judge those messages by my trust list like any other. For now this is watch-only on development agents: nothing is turned away, I only count what would be, and strangers who write in the meantime are marked as first contacts rather than trusted ones. Before it is switched on, I will add the agents I really work with to my trust list.

## Summary of New Capabilities

- Relay unknown-sender path: sender trust resolved from the trust manager, with the relay gate's operation table.
- `threadline.relayUnknownSenderTrust: { enabled?, dryRun? }` — dev-gated, dry-run by default.
- Authed `/health` → `threadline.relayUnknownSenderTrust` (`enabled`, `dryRun`, `evaluated`, `allowed`, `wouldRefuse`, `refused`, `firstContactProfiles`, `lookupErrors`, `profilesCreatedUntrusted`, `unmarkedSetupDefaultProfiles`).
- Trust profiles can carry `relayFirstContact: true`.

## Evidence

- `tests/unit/a2a-relay-unknown-sender-trust.test.ts` (32): verdict against a real `AgentTrustManager` for every level × operation; the handler in off / dry-run / enforcing; the durable first-contact mark across a restart; the profile default; mode resolver; log line; migration parity.
- `tests/integration/threadline/a2a-relay-unknown-sender-trust.test.ts` (4): a real AgentServer's authed `/health`, live mode flips.
- `tests/e2e/threadline/a2a-relay-unknown-sender-trust-alive.test.ts` (3): real RelayServer, real bootstraps, real plaintext sends in dry-run and enforcing.
