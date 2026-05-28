# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**1. Mentor cycle round-trip — final fixes (verified live end-to-end).** Three bugs that only surfaced when the full Echo↔Codey round-trip ran on real servers:

1. **`mentor.menteeAgentName` config.** The mentor derived the mentee's agent name as `instar-${menteeFramework}` (e.g. `instar-codex-cli`), but the mentee registers under its real name (`instar-codey`). The mismatch broke same-machine peer lookup AND the reply allowlist. New optional `mentor.menteeAgentName` (defaults to `instar-${menteeFramework}`) carries the real registry name.
2. **botId string coercion.** `mentor.menteeBotId` is often stored as a JSON number, but the a2a marker's `senderBotId` is always a string. The allowlist compares with `===`, so a number/string mismatch silently dropped every reply as `agent-marker-unknown`. All botId allowlist entries are now `String()`-coerced.
3. **`senderBotId` = sender's own bot id.** The unified transport sent the *recipient's* bot id as the inbox `senderBotId`; the recipient's allowlist check (`knownAgents[from].botId === senderBotId`) therefore always failed. It now sends the *sender's* own bot id (`ownPrimaryBotId()` for replies, the mentor bot id for sends).

With these, the mentor cycle round-trips live: a mentor prompt reaches the mentee, the mentee spawns a session + replies, and the reply lands in the mentor's `mentor-replies.jsonl`.

**2. Threadline identity-discovery unification** (spec `docs/specs/threadline-identity-discovery-unification.md`, approved). Fixes a fleet-wide bug where an agent advertised a Threadline identity its own relay does not answer to — so peers who discovered it got a dead address and their messages silently vanished.

Discovery (`agent-info.json`) and `/threadline/health` now advertise the **routing fingerprint** — the address the relay actually registers with — plus a `publicKey`/`identityPub` set to the SAME canonical `identity.json` key, so the two are internally consistent (`fingerprint === computeFingerprint(publicKey)`). Both are resolved via `IdentityManager.get()`, the exact read-only call the relay client uses, so discovery and routing can never re-diverge.

## What to Tell Your User

- The cross-agent mentor cycle now works fully end-to-end on the same machine — verified with a real round-trip. These were the last three wiring bugs (an agent-name assumption, a number-vs-string comparison, and a sender-identity mixup). No config changes required unless your mentee's registry name differs from `instar-<framework>`, in which case set `mentor.menteeAgentName`.
- If another agent's messages to me were vanishing (their side said "sent" but nothing arrived), the Threadline fix addresses it: I was handing out an address my relay doesn't listen on. Now I publish the right one everywhere, and existing agents are repaired automatically on the next update/restart — no action needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `mentor.menteeAgentName` | Set in `.instar/config.json` when the mentee's agent-registry name differs from `instar-<menteeFramework>` (e.g. `instar-codey`). Defaults to the framework-derived name. |
| Robust botId matching | botId allowlist entries are string-coerced; `senderBotId` is the sender's own bot id. No action needed — fixes silent reply drops. |
| `fingerprint` field in `/threadline/health` + `agent-info.json` | `curl localhost:PORT/threadline/health` → `fingerprint` is the routable relay address |
| Threadline fleet repair migrator | `migrateThreadlineAgentInfoIdentity` runs on update; rewrites a diverged `agent-info.json` to the canonical consistent pair (no-op when already aligned or no routing identity) |

## Behavior Notes (Threadline)

- **No fabrication:** an agent with no resolvable routing identity (none on disk, or a locked-encrypted `identity.json`) now OMITS `fingerprint`/`publicKey` from discovery instead of inventing a dead address. It becomes relay-discoverable once it has a routing identity (self-heals on the next boot).
- **Safe encoding/consumer story:** `publicKey` stays hex and is a valid 32-byte Ed25519 key; `/threadline/health.identityPub` switches to the canonical key only when one resolves. The E2E handshake exchanges keys inline (does not read these fields) and `verifyAgent` does no real crypto challenge, so the switch is safe.

## Evidence

- **Mentor cycle:** extended `mentor-reply-via-inbox` E2E with a second case proving the menteeAgentName override + numeric-configured botId (string senderBotId) routes + persists. Both cases green; all prior mentor/mentee/inbox tests green. **Live-verified**: full Echo→Codey→Echo round-trip persisted to `mentor-replies.jsonl`. Side-effects: `upgrades/side-effects/mentee-agent-name-and-botid-coercion.md`.
- **Threadline — wiring (load-bearing):** boot the Threadline stack with a seeded canonical identity → `agent-info.json.fingerprint` equals `IdentityManager.getOrCreate().fingerprint` (the relay's registration source). `tests/e2e/threadline/identity-discovery-wiring.test.ts`.
- **Threadline — integration:** `/threadline/health` returns a non-empty `identityPub` + a `fingerprint` equal to the relay-registration fingerprint, internally consistent. `tests/integration/threadline/identity-discovery-health.test.ts`.
- **Threadline — unit (both-sides):** identity present → consistent pair advertised; no/locked identity → both omitted; orphan `identity-keys.json` present → canonical advertised, never the orphan hex. `ThreadlineBootstrap.test.ts`, `ThreadlineEndpoints.test.ts`.
- **Threadline — migrator:** diverged → repaired; aligned → no-op; no-identity → no-op (no fabrication); idempotent. `tests/unit/PostUpdateMigrator-threadlineAgentInfoIdentity.test.ts`. Verified end-to-end via test-as-self against the built dist (positive + no-identity boundary).

## Out of Scope (Threadline — tracked separately)

- Multi-machine same-fingerprint advertisement coordination (cross-machine seamlessness spec). This fix sets the `machine` field and is neutral for multi-machine.
- Retiring the orphan `identity-keys.json` / collapsing the keypairs. This fix stops *advertising* the orphan; deleting it touches the handshake layer and needs its own spec.
