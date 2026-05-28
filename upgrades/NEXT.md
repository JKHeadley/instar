# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Threadline identity-discovery unification** (spec `docs/specs/threadline-identity-discovery-unification.md`, approved). Fixes a fleet-wide bug where an agent advertised a Threadline identity its own relay does not answer to — so peers who discovered it got a dead address and their messages silently vanished.

Discovery (`agent-info.json`) and `/threadline/health` now advertise the **routing fingerprint** — the address the relay actually registers with — plus a `publicKey`/`identityPub` set to the SAME canonical `identity.json` key, so the two are internally consistent (`fingerprint === computeFingerprint(publicKey)`). Both are resolved via `IdentityManager.get()`, the exact read-only call the relay client uses, so discovery and routing can never re-diverge.

## What to Tell Your User

- If another agent's messages to me were vanishing (their side said "sent" but nothing arrived), this is the fix: I was handing out an address my relay doesn't listen on. Now I publish the right one everywhere.
- Existing agents are repaired automatically on the next update/restart — no action needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `fingerprint` field in `/threadline/health` + `agent-info.json` | `curl localhost:PORT/threadline/health` → `fingerprint` is the routable relay address |
| Fleet repair migrator | `migrateThreadlineAgentInfoIdentity` runs on update; rewrites a diverged `agent-info.json` to the canonical consistent pair (no-op when already aligned or no routing identity) |

## Behavior Notes

- **No fabrication:** an agent with no resolvable routing identity (none on disk, or a locked-encrypted `identity.json`) now OMITS `fingerprint`/`publicKey` from discovery instead of inventing a dead address. It becomes relay-discoverable once it has a routing identity (self-heals on the next boot).
- **Safe encoding/consumer story:** `publicKey` stays hex and is a valid 32-byte Ed25519 key; `/threadline/health.identityPub` switches to the canonical key only when one resolves. The E2E handshake exchanges keys inline (does not read these fields) and `verifyAgent` does no real crypto challenge, so the switch is safe.

## Evidence

- **Wiring (the load-bearing test):** boot the Threadline stack with a seeded canonical identity → `agent-info.json.fingerprint` equals `IdentityManager.getOrCreate().fingerprint` (the relay's registration source). `tests/e2e/threadline/identity-discovery-wiring.test.ts`.
- **Integration:** `/threadline/health` returns a non-empty `identityPub` + a `fingerprint` equal to the relay-registration fingerprint, internally consistent. `tests/integration/threadline/identity-discovery-health.test.ts`.
- **Unit (both-sides):** identity present → consistent pair advertised; no/locked identity → both omitted; orphan `identity-keys.json` present → canonical advertised, never the orphan hex. `ThreadlineBootstrap.test.ts`, `ThreadlineEndpoints.test.ts`.
- **Migrator:** diverged → repaired; aligned → no-op; no-identity → no-op (no fabrication); idempotent. `tests/unit/PostUpdateMigrator-threadlineAgentInfoIdentity.test.ts`.

## Out of Scope (tracked separately)

- Multi-machine same-fingerprint advertisement coordination (cross-machine seamlessness spec). This fix sets the `machine` field and is neutral for multi-machine.
- Retiring the orphan `identity-keys.json` / collapsing the keypairs. This fix stops *advertising* the orphan; deleting it touches the handshake layer and needs its own spec.
