# Same-machine agent messages are signed, and the receiver can check the signature (watch-only first)

## What Changed

`POST /messages/relay-agent`, the route one agent uses to hand a message to another agent on the same machine, took the sender's name from the request body. The bearer token it checks proves the caller can read a file on the machine, not who the caller is. (Spec: `docs/specs/a2a-local-route-signed-envelope.md`, tracking action ACT-067, commitment CMT-706.)

- **Senders sign, on every agent.** Both senders (the relay-send name path and `MessageRouter`) add a top-level `signature`: base64 Ed25519, made with the agent's Threadline identity key, over `"instar-a2a-local-envelope-v1\n" + canonicalJSON({ message, transport: { nonce, timestamp, relayChain, originServer, originTopicId } })`. An older receiver ignores the field. `MessageRouter` signs before it decides whether to POST or park the message, and only when `from.agent` is this agent.
- **The receiver checks, behind `threadline.localRouteSignature`.** `enabled` omitted means on for a development agent and off on the fleet. `dryRun` defaults to `true`: every envelope is verified, counted, logged (`[relay-agent-signature] would-refuse`) and written to `logs/relay-agent-signature.jsonl`, and delivery is unchanged. With `dryRun: false` a failing envelope is refused before anything records it: `401 { error: 'bad-signature', refused: true, retryable, remedy, reason }`. A passing one hands its key-derived fingerprint to the local-route trust check and the inbound-id ledger key.
- **What is checked.** The signature, against the key the receiver holds for the sender's name (its registry, or a key it fetched itself on first contact, kept in memory only); that `to.agent` is this agent; that the timestamp is within 10 minutes; that the nonce was not seen before. Decision logic: `src/threadline/localEnvelopeSignature.ts`.
- **A sender can require the proof.** A request with the header `X-Instar-Require-Signature: v1` is refused (`reason: 'not-enforcing'`) unless the receiver is enforcing.
- **A refusal is final for `MessageRouter`.** An answer whose JSON body says `refused: true` now fails the send. Before, it was parked in the drop directory and delivered at the receiver's next start with no check.
- **Drop pickup applies the same check when enforcing.** An unproven parked message is held, tried once more five minutes after start, and deleted once it is more than 7 days old.
- **Read surfaces.** Authed `/health` → `threadline.localRouteSignature`; unauthenticated `/threadline/health` → `localEnvelopeSignature: { version: 'v1', mode }`; the route's success answers carry `signature: { mode, verified }` when the mode is not `off`. CLAUDE.md template + migration section "A2A local-route signed envelope".

## What to Tell Your User

When two of my agents on the same computer pass messages directly, the receiver used to believe whatever name the sender wrote. Now every message I send that way carries my digital signature, and I can check the signature on the ones I receive. For now the check is watch-only on development agents and off everywhere else: nothing is turned away, I only record what would be. Once a day of records looks clean, the development agent will start refusing messages it cannot prove, and those messages will still be able to travel over the internet relay.

## Summary of New Capabilities

- Signed same-machine A2A envelopes (`signature` field, Ed25519, Threadline identity key).
- `threadline.localRouteSignature: { enabled?, dryRun? }` — dev-gated, dry-run by default; `off` / `dry-run` / `enforcing`.
- Request header `X-Instar-Require-Signature: v1`.
- Authed `/health` → `threadline.localRouteSignature`; `/threadline/health` → `localEnvelopeSignature`.
- Audit log `logs/relay-agent-signature.jsonl` (one metadata-only row per check).
- `MessageRouter`: an explicit `refused: true` answer fails the send.

## Evidence

- `tests/unit/a2a-local-route-signed-envelope.test.ts` (52): signed bytes and a fixed test vector; every refusal reason against a real registry file and an injected clock; the first-contact key fetch against a stub health source; the replay cache bounds; mode resolver; signer; audit log; `MessageRouter` refusal handling and drop pickup in each mode under a redirected home directory; migration parity.
- `tests/integration/threadline/a2a-local-route-signed-envelope.test.ts` (19): the real route on a real AgentServer in off, dry-run and enforcing; pre-admission refusal (no inbox entry, no ledger row, no content window); a real `MessageRouter` with the production signer.
- `tests/e2e/threadline/a2a-local-route-signed-envelope-alive.test.ts` (6): two real servers with real Threadline bootstraps and a real relay; the real relay-send name path and `POST /messages/send` deliver to an enforcing receiver that fetches the sender's key from its live health endpoint.
