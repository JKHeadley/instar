# Side-Effects Review — Cross-Machine Secret Sync

**Version / slug:** `cross-machine-secret-sync`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required` (Tier 2; single-author under Justin's explicit signoff)

## Summary of the change

Implements Phase 4 of the multi-machine arc: a secret given to the agent on one machine is
distributed, encrypted per-recipient, to its other registered machines so the same agent can
use it everywhere without re-entry. New `src/core/SecretSync.ts` holds a `SecretProvisioner`
(sender: encrypt the secret set to each online peer's X25519 key, push a signed `secret-share`
over the mesh), a `SecretShareHandler` (receiver: decrypt with this machine's own key, store
into the local encrypted vault), and `secretKeyPaths` (names-only flattening for status). The
inbound dispatcher handler was already wired in `src/commands/server.ts`; this change adds the
OUTBOUND provisioner (constructed after the MeshRpcClient), a route-facing `_secretSyncHandle`,
two routes in `src/server/routes.ts` (`GET /secrets/sync-status`, `POST /secrets/sync-now`)
plumbed through `AgentServer` + `RouteContext`, the `multiMachine.secretSync` config type, and
agent-awareness (CLAUDE.md template + `PostUpdateMigrator` section). Crypto is reused, not new
(`encryptForSync`/`decryptFromSync`, forward-secret ephemeral-key X25519→AES-GCM).

## Decision-point inventory

- `multiMachine.secretSync.enabled` gate (server.ts) — **add** — enables inbound handler +
  outbound provisioner; resolves to `config.multiMachine.secretSync.enabled ?? !!developmentAgent`
  (dark for normal agents, on for the dev agent).
- `SecretProvisioner.listPeers` online filter — **add** — only online, registered peers with a
  resolvable encryption key receive a push.
- `secret-share` mesh acceptance — **pass-through** — authenticity, signing, registered-peer
  gate, and nonce replay are already enforced by the existing MeshRpcDispatcher verify/RBAC
  layer; this change adds only application-layer confidentiality on top.

## 1. Over-block

No block/allow surface — over-block not applicable. The two routes 503 only when the feature
is disabled or the handle is absent; they never reject a legitimate request when enabled.

## 2. Under-block

No block/allow surface — under-block not applicable. (Security property of note instead: a
`secret-share` payload sealed to machine A cannot be decrypted by machine B — GCM auth fails —
covered by the "wrong key fails" unit test.)

## 3. Level-of-abstraction fit

Right layer. The transport-level guarantees (TLS, Ed25519 signing, registered-peer gate, nonce
replay) live in the mesh and are reused, not re-implemented. This change is purely the
application-layer secret-distribution logic over that transport, plus thin route/handle wiring.
It USES the existing `encryptForSync`/`decryptFromSync` primitive rather than rolling new crypto,
and USES `SecretStore.read()`/`set()` rather than re-implementing vault access. No higher-level
gate is duplicated.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The routes are read (status) and an explicit push lever; neither holds block authority over any
message or operation. The mesh acceptance layer (the existing smart authority) owns
accept/reject for `secret-share`.

## 5. Interactions

- **Shadowing:** none. The two new routes are new paths (`/secrets/sync-status`,
  `/secrets/sync-now`) that don't sit before/after any existing check.
- **Double-fire:** the inbound `secret-share` handler is idempotent at the vault level — a
  re-delivered share just re-writes the same decrypted value (rotate=overwrite, per spec).
  Boot best-effort push + the deterministic route can both push the same set; the receiver
  storing the same value twice is harmless.
- **Races:** `SecretStore.read`/`set` is read-modify-write to one encrypted file via an atomic
  temp-file rename. Concurrent shares writing different key-paths could interleave a read with a
  write; v1 syncs the whole set on provision and overwrites, so a lost interleaved write is
  re-converged by the next push. Flagged as a known v1 limitation, not a correctness break for
  the single-writer-at-a-time provision pattern.
- **Feedback loops:** none. A received share does not itself trigger a re-push (no boot/provision
  event fires on inbound store), so shares don't ping-pong between machines.

## 6. External surfaces

- **Other agents on the same machine:** none — keyed to this agent's own mesh + vault.
- **Install base:** ships DARK; a normal agent and a single-machine agent are no-ops.
- **External systems:** none new. Uses the existing mesh transport between the user's own paired
  machines; no third-party service involved.
- **Persistent state:** writes decrypted secrets into the RECEIVING machine's existing encrypted
  vault (`config.secrets.enc`) — the same store Secret Drop / SecretMigrator already write. No
  new on-disk plaintext; the wire payload is forward-secret encrypted.
- **Timing:** boot best-effort push is fire-and-forget and never blocks startup.

## 7. Rollback cost

Pure code change behind a dark flag — revert and ship a patch; no user-visible regression during
the rollback window (the feature is off for everyone except the dev agent). The only persistent
side effect is that secrets already pushed to a peer remain in that peer's vault after rollback —
which is the intended end-state (the user wanted them there) and requires no cleanup. No schema
or migration to unwind.

## Conclusion

The review surfaced one honest v1 limitation (whole-set overwrite means an interleaved partial
write is re-converged on the next push rather than merged) which is acceptable for the
push-on-provision model and is documented. No design changes were required. Crypto is reused, the
transport gate is reused, the feature ships dark, and rollback is a clean revert. Clear to ship
through the ceremony, with live-verification on the real laptop+mini pair as the final gate
before enabling it beyond the dev agent.

## Evidence pointers

- 15 tests green: `tests/unit/secret-sync.test.ts` (8), `tests/integration/secret-sync-routes.test.ts`
  (4, real crypto round-trip through HTTP + no-value-leak asserts), `tests/e2e/secret-sync-alive.test.ts`
  (3, real AgentServer alive + round-trip into a peer vault + auth).
- `tsc --noEmit` clean; `npm run lint` clean.
- Spec: `docs/specs/cross-machine-secret-sync-spec.md` (approved).
