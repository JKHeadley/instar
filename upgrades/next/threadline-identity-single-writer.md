# Agent-to-agent identity: one writer, checked reads, and self-repair for agents the relay kept refusing

## What Changed

A bug fix (spec: `docs/specs/threadline-identity-single-writer.md`, ACT-062; approved under the operator's standing approval for the agent-comms track). No config key, route or stored state is added.

- **The defect.** An agent whose first start had the relay off could never connect once the relay was enabled. `HandshakeManager` wrote `threadline/identity.json` in hex whenever another local agent polled `/threadline/health`; every reader decoded the file as base64 with no length check, so 64 hex characters became a 48-byte "key"; the migration copied that into the canonical `identity.json`, which then won on every start. The relay answered `Invalid public key — expected raw 32-byte Ed25519, got 48 bytes`, permanently.
- **One writer.** A new module, `src/identity/IdentityKeyFile.ts`, holds the only decoder and the only raw file write for identity keys. `HandshakeManager` takes its key from the identity manager and writes no key file. `/threadline/health` leaves out `identityPub` and `fingerprint` when the agent has no identity yet; it never creates one.
- **Checked reads.** A stored key must decode to exactly 32 bytes and the public key must belong to the private key.
- **Self-repair.** A file whose keys are 64 hex characters holds the right key in the wrong text form. It is decoded as hex and rewritten as base64, atomically and owner-only, in both the legacy and the canonical file. The key does not change, so the agent's address does not change.
- **No silent new identity.** A file that is invalid in any other way is left untouched and reported as a `Threadline.identity` degradation. Before, a corrupt file was replaced by a brand-new identity without a word.
- **Creation race closed.** Two processes that both find no identity file now end with one identity: creation never replaces an existing file, and the later process adopts what is on disk.
- **Truthful start-up log.** `Threadline: relay connected to <host>` is printed only when the connection is up. Otherwise the line says `relay NOT connected to <host> (state: …)`.
- **File hygiene.** Identity files and `relay-tokens.json` are written atomically with mode `0600`.

## What to Tell Your User

If my connection to other agents was stuck because the relay kept refusing me, it fixes itself the next time I start. My identity key had been saved in the wrong text form; I now read it correctly and save it properly. It is the same key, so my address is the same and other agents do not need to do anything. My start-up log also stops claiming I am connected when I am not. If my key file is ever damaged in some other way, I will say so and stay off the relay rather than quietly switch to a new address.

## Summary of New Capabilities

- No new capability. Existing agents regain the relay connection the defect blocked.
- `/threadline/health` omits `identityPub` and `fingerprint` for an agent with no identity (it used to return a throwaway key).
- New `Threadline.identity` degradation for an unusable key file, or for two key files that hold different identities.

## Evidence

- `tests/unit/identity/IdentityKeyFile.test.ts` (32): decoder, write primitives, refusals, hex legacy and hex canonical fixtures repaired with the same key and the fingerprint the hex key implies, migration from a hex file.
- `tests/unit/threadline/identity-single-writer.test.ts` (23): a source scan that fails if another module writes an identity file, `HandshakeManager` uses the one identity, the start-up line.
- `tests/unit/threadline/identity-create-race.test.ts` (3): two creators, one identity.
- `tests/integration/threadline/identity-single-writer-health.test.ts` (8): the real health route with real discovery and the local-route check.
- `tests/e2e/threadline/identity-single-writer-lifecycle.test.ts` (4): a real bootstrap against a real relay — relay off, health polled, relay on: the relay is offered a 32-byte key and the fingerprint matches health; an already-broken agent connects on its next start.
