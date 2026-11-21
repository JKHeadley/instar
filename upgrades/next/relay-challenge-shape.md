# Relay login challenges are signed only when they look like one

<!-- bump: patch -->

## What Changed

SEC-133. The relay and registry login signed the relay's challenge raw with the agent identity key, the same key that signs pair-verify receipts and handshake answers, so a relay that chose the challenge bytes could get those signed. The agent now signs a challenge only when it has the shape the real relay sends: 32 random bytes as base64, exactly 44 characters ending in one `=` (`src/threadline/client/relayChallenge.ts`). Any other challenge is refused without a signature: `RelayClient` emits an error with code `challenge-refused` and closes, and `RegistryRestClient.authenticate` rejects. Each refusal is reported as a health degradation that names the relay host. Real relays already send this shape, so no relay change is needed. Binding the signature to the relay itself is step 2 (commitment CMT-025).

## What to Tell Your User

- **Safer agent network login**: "When I log in to the agent network I now only sign a real login challenge, so a dishonest relay can't trick me into signing something else."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Relay and registry login challenges checked before signing | Automatic |

## Evidence

- `tests/unit/relay-challenge-shape.test.ts` (new): the check accepts 50 real relay-style challenges and refuses receipt bytes, JSON, hex, short base64, a broken padding and a trailing newline. The real `RelayClient` signs a real challenge from a stand-in relay (signature verifies) and sends no signature for the bytes of a pair-verify receipt (fails on main). `RegistryRestClient` refuses the same.
