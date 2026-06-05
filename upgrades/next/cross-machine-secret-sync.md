# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Finishes Phase 4 of the multi-machine arc: cross-machine secret sync. A secret given to the
agent on one machine can now be distributed, encrypted, to its other machines — so the same
agent can use it everywhere without the user re-entering it per machine.

- **`SecretSync` module** — `SecretProvisioner` (sender side: encrypts the secret set per
  recipient to that machine's X25519 key and pushes a signed `secret-share` over the mesh) +
  `SecretShareHandler` (receiver side: decrypts with this machine's own key and stores into
  the local encrypted vault) + `secretKeyPaths` (names-only flattening for status).
- **Reuses the existing forward-secret crypto** (`encryptForSync`/`decryptFromSync`,
  ephemeral-key-per-payload X25519 → AES-GCM); the mesh already enforces TLS, Ed25519
  signing, and the registered-peer gate, so this adds application-layer confidentiality.
- **Two routes** (both behind auth): `GET /secrets/sync-status` reports which secret key
  NAMES this machine holds plus the peers it would sync to (never a value); `POST
  /secrets/sync-now` is the deterministic push lever (encrypts per online peer and pushes).
- **Config flag** `multiMachine.secretSync.enabled` — ships dark; defaults on only for the
  development agent. A single-machine agent is a no-op.

## What to Tell Your User

- **A secret you give me on one machine can become usable on your other machines** — a bot
  token, an API key, a login — without you setting it up again on each computer. It travels
  encrypted to each of your machines and is never written down in plain text along the way.
- This is an early capability and ships turned off by default. When it is on, if you ever
  start re-entering something you already gave me elsewhere, I can tell you it already synced.

## Summary of New Capabilities

- Cross-machine secret distribution: drop a secret once, use it on every paired machine.
- A read-only status view of which secrets a machine holds (names only, never values).
- A deterministic push lever to sync secrets on demand.

## Evidence

15 tests across all three tiers: 8 unit (real-crypto round-trip, per-recipient sealing,
wrong-key-fails confidentiality, best-effort fan-out, names-only flattening), 4 integration
(real SecretStore + real crypto encrypt→ship→decrypt through the HTTP routes, asserting no
secret value ever appears in a response, plus the 503-when-disabled paths), and 3 e2e (the
routes alive through the real AgentServer with a genuine round-trip into a peer vault, behind
auth). Spec: docs/specs/cross-machine-secret-sync-spec.md (approved).
