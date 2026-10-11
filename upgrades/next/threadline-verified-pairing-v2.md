# Verified pairing can now actually start between relay agents (12 words, v2)

## What Changed

Verified pairing had every part except the one that starts a pairing. The SAS derivations had no caller in `src/`, `AgentTrustManager.recordPendingVerification` was called only from tests, and `HandshakeManager` is reachable only through the HTTP `/threadline/handshake/*` routes, which agents talking over the relay never use. So no real pairing could reach `pending-verification` (issue #2117 gap G). (Spec: `docs/specs/secure-a2a-verified-pairing.md` §3.0, design agreed with Echo.)

- **v2 words come from the two Ed25519 identity keys alone**, so each side starts on its own with no handshake: `POST /threadline/pairing/:peerFp/start` or `threadline_pair` `start`. The peer's key comes from the relay client's known-agent cache and must match the fingerprint.
- **12 words (132 bits) instead of 6.** A relay that swaps keys controls both of its fake keys, so 66 bits fall to a ~2^33 offline search; 132 bits put it at ~2^66.
- **A denied match stays failed** until an operator clears it with the dashboard PIN (`clearFailed: true`). A rotated identity key resets the pairing to pending.
- **Receipts are v2:** they sign `issuedAt`, and a stale or future-dated receipt is dropped with no state change.
- **Credential-share now also refuses** (`encryption-key-not-bound`) unless the peer's encryption key is the one derived from its verified identity key and the pairing still matches our current key.
- Still dark behind `threadline.verifiedPairing.enabled`. CLAUDE.md template updated; a migration section reaches agents that already have the v1 text.

## What to Tell Your User

The six-word check that's meant to prove another agent is who it says it is could never actually start between two agents on the relay. Nothing was wired up to create the pairing in the first place. Now either agent can start it, both see the same 12 words, and you compare them with the other side before confirming with your PIN. It's twelve words instead of six because a dishonest relay could otherwise search for fake keys that make both sides see matching words. I also won't send another agent a password unless the key I'd encrypt it with provably belongs to the agent you verified.

## Summary of New Capabilities

- `POST /threadline/pairing/:peerFp/start` (Bearer; `clearFailed: true` needs the dashboard PIN).
- `threadline_pair` MCP action `start`.
- 12-word v2 SAS; `edPublicToX25519` / `isX25519BoundToIdentity` in `ThreadlineCrypto`.
- Credential-share refusal reason `encryption-key-not-bound`.

## Evidence

- `tests/unit/threadline-pairing-v2.test.ts` (12): the Ed25519→X25519 map matches the encryptor's key on 200 random keys; the 12 words are symmetric and change with either key; receipt freshness on both sides of each 5-minute bound; start rules (rotation resets, denied stays failed).
- `tests/e2e/threadline-pairing-v2-relay-agents.test.ts` (5): two real AgentServers start the pairing on their own through the route and reach pending with the same 12 words; a substituted key gives different words; a cached key that mismatches its fingerprint is refused; a credential is allowed only over a bound key; a denied match needs the PIN.
- Twelve deliberate breakages (binding check, own-rotation check, gate, denied reset, fingerprint check, key-pair order, stale and future receipt checks, PIN on clear, curve-map sign bit, word count, migration idempotence) each fail at least one test.
