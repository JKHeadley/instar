# Sealed Handoff — Implementation Plan (file-level)

Grounded against the worktree base (JKHeadley/main @ v1.3.177). Companion to `SEALED-HANDOFF-SECURE-SECRET-TRANSFER-SPEC.md`.

## Key de-risking insight (keystone)
`POST /secrets/request` (`src/server/routes.ts:9013`) is HTTP-bearer-gated; the agent's own `authToken` is externalized (`{secret:true}`) so an agent can't self-mint over HTTP. **BUT the MCP server runs in-process with the `SecretDrop` instance** (`src/server/SecretDrop.ts`) → a `threadline_request_secret` MCP tool can call `SecretDrop.createRequest()` **directly**, no HTTP bearer. Keystone solved without scraping the vault.

## Steps (each: code → tests → atomic commit)

1. **R1b — endpoint+cert pinning in the invitation** (`src/threadline/SecureInvitation.ts`)
   - Add `submitHost: string` + `submitCertFingerprint: string` to `InvitationToken` (iface @ line 19).
   - Include both in the canonical signed message at the sign callsite (~line 171) so the existing Ed25519 `verify` covers them automatically (tamper → sig invalid).
   - Expose them on the verify result so the sender validates the destination against the receiver's key before POSTing.
   - Unit: valid token carries host/certFp; tampering either invalidates signature; expiry/single-use still enforced.

2. **Keystone — `threadline_request_secret` MCP tool (receiver self-mint)** (`src/threadline/ThreadlineMCPServer.ts` + `SecretDrop`)
   - In-process call to `SecretDrop.createRequest()` → write-only one-time URL; build the R1b invitation signed by the receiver's Ed25519 key; return the invitation to send over the relay.
   - Unit: returns a usable one-time URL + a valid signed invitation; no HTTP bearer needed.

3. **R1a — sender-signature verify on submit** (`src/server/SecretDrop.ts` + the submit route in `routes.ts`)
   - Locate the submit handler (POST to the one-time URL). Require the submitted payload carry an Ed25519 signature by the sender; verify against the sender's pinned pubkey (from the invitation/trust store) **before accept/store**. Reject unsigned / wrong-key / replayed.
   - Unit: accept valid sig; reject unsigned, wrong-key, replayed (nonce reuse).

4. **R2 — operator-confirm gate (requester ≠ authorizer)** (new gate module, wired into the accept path)
   - Accept completes only with an operator-authorization record bound to the HOLDER (sender), confirmed out-of-band; enforce requester identity ≠ authorizer identity in code. A relayed "operator said go" is not an authorization record.
   - Integration: gate blocks with no/wrong auth record; blocks when requester == authorizer.

5. **R3 — at-rest invariant E2E** (`tests/e2e/`)
   - Drive a full sealed handoff; assert the secret value appears in NONE of: `collaboration-surface.json`, inbox JSONL, conversation stores, any Telegram-routed payload. Attestation endpoint reports invariant held. (Single most important test — guards the original leak.)

6. **Ergonomic wrapper** — receiver `threadline_request_secret` (step 2) + a sender-side submit helper (signs payload, validates host/certFp from invitation, POSTs).

7. **Ship-gate** — `upgrades/NEXT.md` (required sections + Evidence + bump; a MERGE≠RELEASE), `npm run lint` + `tsc`, full 3-tier green, side-effects review, independent adversarial review, flip spec `approved:true` in the PR. Reuse the mechanics in memory `reference_instar_release_and_shipgate_mechanics`.

## Wiring (must-haves key-links to verify in Phase 3)
- MCP server registers `threadline_request_secret` (grep tool registration).
- Submit route calls the sender-signature verifier before store (grep).
- Server boot constructs the operator-confirm gate and the accept path consults it (grep).
