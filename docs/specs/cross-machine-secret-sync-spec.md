---
title: "Cross-Machine Secret Sync"
slug: "cross-machine-secret-sync"
author: "echo"
eli16-overview: "cross-machine-secret-sync-spec.eli16.md"
approved: true  # Signed off by Justin (topic 13481, 2026-06-04): "build secret sync, use your best judgment" + answered the 3 open questions. The 3 judgment calls: push-on-provision primary + pull-on-miss fallback; sync ALL {secret:true} fields; rotate=overwrite (dedicated revoke verb deferred to a follow-up).
principal-signoff: "Justin, 2026-06-04 (topic 13481)"
layer: "core-instar-primitive"
status: "approved"
review-convergence: "2026-06-05T00:26:04.156Z"
review-iterations: 2
review-completed-at: "2026-06-05T00:26:04.156Z"
review-report: "docs/specs/reports/cross-machine-secret-sync-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "codex CLI not installed on this machine"
---

# Cross-Machine Secret Sync

## Motivation

Multi-machine support means one agent spans machines. Phase 4 of the multi-machine arc is **secret sync**: a secret the user gives the agent on one machine (a Telegram bot token, an API key, a GitHub PAT) must be usable by the same agent on its other machines — without the user re-entering it per machine, and without secrets ever living in git-tracked config.

Today this is half-built. This spec finishes it.

## What already exists (evidence-grounded, 2026-06-04)

- **`SecretStore` / `SecretManager`** — the per-machine encrypted secret store (`.instar/config.secrets.enc`). Local only.
- **`SecretMigrator`** — extracts `{ "secret": true }`-annotated fields out of git-tracked `config.json` into `SecretStore` and merges them back transparently on load. Runs at `instar pair`. Local only. (Header: "Part of Phase 4 (secret sync via tunnel).")
- **`MeshRpc` `secret-share` verb** — a reserved RBAC slot (`src/core/MeshRpc.ts`): allowed for any registered peer, classed as "read/observe or e2e-encrypted". **This is the only cross-machine secret surface, and it is a stub.**

### The precise gap (why it does not work today)

1. **No dispatcher handler.** `server.ts` wires mesh handlers for `capacity-report`, `session-status`, `place`, `claim`, `transfer`, `release`, `deliverMessage` — but **not** `secret-share`. An inbound `secret-share` envelope has nothing to process it.
2. **No sender.** Nothing in `src/` ever emits a `secret-share` command. There is no provisioning flow that pushes a new secret to peers, and no pull-on-demand path.
3. **State-sync does not carry it.** The cross-machine state replication (`BackupManager` / `TransferOrchestrator`) does not include `config.secrets.enc` — by design (a machine's at-rest secret blob is encrypted to *that machine*, so byte-copying it is useless to a peer).

Net: the protocol reserved a verb; the implementation was never built.

## Design

### Threat model

- The transport is already TLS (the tunnel) + the MeshRpc envelope is Ed25519-signed and recipient-bound with a nonce (replay-proof) and a registered-peer check. So *authenticity and transport* are solved.
- The remaining requirement is **confidentiality of the payload at the application layer**: a secret in flight must be encrypted to the recipient machine's key, so it is never readable by an intermediary (e.g. a relay) and never logged in plaintext. Each machine already publishes an `encryptionPublicKey` in its `MachineIdentity`.

### The two flows

**Push-on-provision (primary).** When a machine A has secrets to share, A enumerates its registered, online peers and sends each a `secret-share` envelope whose payload is the **whole secret set sealed to that peer** — a single forward-secret `EncryptedSecretPayload` produced by `encryptForSync(secrets, peer.encryptionPublicKey)` (ephemeral-key X25519 → AES-GCM). The peer's handler verifies the envelope (existing mesh acceptance), decrypts with its private key, and writes each key-path into its own `SecretStore`. Idempotent by overwrite (rotate = overwrite, so re-shipping the same set re-writes the same values).

> **v1 implementation note (reconciled with the shipped code).** v1 fires push-on-provision from a **boot best-effort** push (covers a peer that comes online after a secret was provisioned elsewhere) plus a **deterministic `POST /secrets/sync-now`** lever (the analog of `POST /pool/transfer`) that an agent calls directly. Hooking the push automatically into the Secret Drop completion + `SecretMigrator` extraction seams is a **deferred follow-up** — the boot push + the explicit lever cover the same ground without coupling into those code paths in v1.

**Pull-on-miss (fallback) — DEFERRED to a follow-up.** The intended fallback: a machine that loads config and finds a `{ "secret": true }` placeholder with no local value issues a `secret-share` *request* to a peer, which responds with the per-recipient-encrypted set. v1 does **not** implement the request direction; the boot best-effort push + the deterministic lever cover the common "offline during provision" case (the returning machine pushes/pulls on its next provision or on an explicit `sync-now`). The request-driven pull is a clean, isolated follow-up.

### Components to build

- `SecretShareHandler` (`src/core/SecretSync.ts`) — the inbound handler: decrypt with this machine's key → `SecretStore.set`. Dependency-injected store + own-key; unit-tested both directions (valid peer stores; foreign-key payload rejected via GCM auth). (Envelope authenticity/signing/registered-peer/replay are enforced by the existing mesh acceptance layer BEFORE this runs.)
- `SecretProvisioner` (`src/core/SecretSync.ts`) — the push sender: seal the set per online registered peer + fan out best-effort (one peer's failure never aborts the others). `secretKeyPaths()` provides names-only flattening for status.
- Wire `secret-share` into the `server.ts` mesh dispatcher `handlers` block (inbound) + construct the provisioner after the MeshRpcClient (outbound), exposed to routes via a `_secretSyncHandle`.
- Routes: `GET /secrets/sync-status` (which key-path NAMES this machine holds + the peers it'd sync to — never values) and `POST /secrets/sync-now` (the deterministic push lever) — both behind auth, both 503 when the feature is disabled. Mirrors the read-only/deterministic-lever ethos of `/pool/placement` + `/pool/transfer`.

### Guarantees

- **Never on disk in plaintext, never in a log** — payloads are encrypted to the recipient; the existing `SecretRedactor` covers log paths.
- **Never to a non-peer** — gated by the existing registered-peer RBAC + signature verification.
- **Dark by default** — gated behind `multiMachine.secretSync.enabled`, resolving to `config.multiMachine.secretSync.enabled ?? !!config.developmentAgent`; a single-machine agent is a no-op. Live on the dev agent (echo) first via the `developmentAgent` pattern.
- **Migration parity** — because the gate falls back to the `developmentAgent` flag, **no `migrateConfig` default write is needed** (the feature is dark for normal agents and on for the dev agent with zero config). Agent-awareness IS migrated: the CLAUDE.md template (`generateClaudeMd`) documents the two routes + the "your other machines now have this credential" behavior for new agents, and `PostUpdateMigrator.migrateClaudeMd` content-sniffs + appends the same section so existing agents learn it on update.

## Testing (all three tiers, per the Testing Integrity Standard)

- Unit: `SecretShareHandler` (stores on a valid payload; rejects a foreign-key payload via GCM auth), `SecretProvisioner` (encrypts per-recipient; best-effort fan-out continues past one peer's failure; no-ops with no secrets/peers), `secretKeyPaths` (names-only flattening).
- Integration: HTTP round-trip through the real routes — a real `SecretStore` + real crypto encrypt→ship→decrypt into a peer vault via `POST /secrets/sync-now`; `GET /secrets/sync-status` reflects the local key-path NAMES; both routes 503 when disabled; assert no secret VALUE appears in any response.
- E2E: a real `AgentServer` with the handle wired — both routes alive (200, behind auth), with the genuine round-trip landing the decrypted secret in a peer vault.

## Open questions for Justin — RESOLVED (signoff 2026-06-04, topic 13481)

Justin: "build secret sync, use your best judgment." The three judgment calls, as built:

1. **Push vs pull default** — RESOLVED: **push primary** (boot best-effort + deterministic `POST /secrets/sync-now` in v1); pull-on-miss deferred to a follow-up (see the v1 implementation note above).
2. **Scope of what syncs** — RESOLVED: **all `{ "secret": true }` fields** (the user-entrusted set, read directly from `SecretStore.read()`).
3. **Revocation** — RESOLVED: a rotation **overwrites** the old value; a dedicated *delete*/revoke verb is a deliberate follow-up (kept out of v1 to stay tight).

## Work breakdown
1. `SecretShareHandler` + unit tests. 2. `SecretProvisioner` + unit tests. 3. Dispatcher wiring + `GET /secrets/sync-status`. 4. Integration + E2E. 5. Config flag + migration + template. 6. instar-dev ceremony + PR.
