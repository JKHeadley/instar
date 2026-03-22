# Track 3: Multi-Machine Sync

## Executive Summary
Multi-machine is a substantial implementation spanning 30+ source files with 14+ dedicated test files across all three tiers (unit, integration, E2E). It uses Node.js native crypto (Ed25519/X25519) for identity, a heartbeat-based role coordination system (2-min broadcast, 15-min failover), and timestamp-based split-brain resolution. The handoff protocol supports explicit role transfer with challenge-response verification. This is NOT a stub — it's a production-grade implementation with failover hardening (cooldowns, max attempts, optional confirmation).

---

## 1. Module Map

**Core files:**

| Purpose | Files |
|---------|-------|
| Cryptography | `src/threadline/ThreadlineCrypto.ts` |
| Handshake | `src/threadline/HandshakeManager.ts` |
| Heartbeat | `src/core/HeartbeatManager.ts` |
| Relay | `src/threadline/relay/RelayServer.ts`, `PresenceRegistry.ts`, `MessageRouter.ts` |
| HTTP Routes | `src/server/machineRoutes.ts` |
| Auth | `src/server/machineAuth.ts` |
| Trust | `src/threadline/TrustBootstrap.ts`, `AgentTrustManager.ts` |
| Tunnel | `src/tunnel/TunnelManager.ts` (Cloudflare tunnel) |

Plus 20+ more files in `src/threadline/` including A2A gateway, MCP server, circuit breaker, rate limiter, etc.

---

## 2. Cryptographic Identity

**[VERIFIED]** `src/threadline/ThreadlineCrypto.ts`

- **Ed25519** identity keys (line 27-33): `crypto.generateKeyPairSync('ed25519')` — Node.js native
- **X25519** ephemeral keys (line 39-45): `crypto.generateKeyPairSync('x25519')` — single-use per handshake
- **ECDH** shared secret (lines 88-111): `diffieHellman()` returns 32-byte shared secret
- **HKDF-SHA256** token derivation (lines 119-121): `crypto.hkdfSync('sha256', sharedSecret, salt, info, 32)`
- **NO external crypto libraries** — all Node.js native `node:crypto`

---

## 3. Pairing Protocol

**[VERIFIED]** `src/threadline/HandshakeManager.ts`

**Initiator flow (`instar pair`)** (lines 127-156):
1. Rate limit check (max 5/minute)
2. Generate ephemeral X25519 key pair
3. Random nonce (32 bytes hex)
4. Send HelloPayload with identityPub, ephemeralPub, nonce

**Responder flow (`instar join`)** (lines 166-223):
1. Rate limit check
2. Parse incoming identity & ephemeral keys
3. **Glare resolution**: if both sent hellos, lexicographically lower pubkey wins (line 182)
4. Generate response ephemeral key + nonce
5. Compute challenge response

**Challenge-response** (lines 133-149):
- Signs: `SHA256(nonce || identityPubA || identityPubB || ephPubA || ephPubB)`
- Prevents relay/MITM attacks by binding both identities

**Relay token derivation** (line 88):
- Info: `'threadline-relay-token-v1'`
- Salt: sorted public keys → deterministic on both sides

---

## 4. Heartbeat Mechanism

**[VERIFIED]** `src/core/HeartbeatManager.ts`

| Parameter | Value | Line |
|-----------|-------|------|
| Broadcast interval | 2 minutes | 22 |
| Failover timeout | 15 minutes | 23 |
| Failover cooldown | 30 minutes | 24 |
| Max failovers/24h | 3 | 25 |

**Heartbeat structure (lines 29-38):**
```typescript
interface Heartbeat {
  holder: string;      // Machine ID
  role: MachineRole;   // 'awake' | 'standby'
  timestamp: string;   // ISO
  expiresAt: string;   // ISO (now + timeoutMs)
}
```

- **Write** (lines 102-120): Awake machine writes periodically, atomic file write (tmp+rename)
- **Check** (lines 150-179): Hot-path check before every Telegram poll
  - Stale if age > 2 × INTERVAL (4 minutes)
  - Expired if current time > expiresAt
- **Failover decision** (lines 244-282):
  - 30-min cooldown between auto-failovers
  - Max 3 failovers per 24h, then disabled until manual reset (lines 304-309)

---

## 5. Write Authority & Split-Brain Resolution

**[VERIFIED]** `src/core/HeartbeatManager.ts:207-236`

**Split-brain resolution via timestamp ordering:**
- `processIncomingHeartbeat(incoming)`:
  - Ignore if from self (line 208)
  - If we don't have heartbeat, incoming wins → demote (line 213)
  - If we're not holder, passively accept newer (line 216-221)
  - **Conflict**: newer timestamp wins (line 228), loser demotes automatically

**Demotion callback** (`machineRoutes.ts:92-95`):
- `ctx.onDemote?.()` pauses job scheduler, stops Telegram polling

---

## 6. State Sync

**[VERIFIED]** Hybrid strategy (from `docs/specs/MULTI-MACHINE-SPEC.md:60-80`):

| Sync Method | What | Frequency |
|-------------|------|-----------|
| Git | Config, relationships, job defs | Low (human-reviewable) |
| Tunnel/API | Job runs, session state, activity logs | High (machine-generated) |

**API endpoints** (`src/server/machineRoutes.ts`):
- `/api/heartbeat` — Role coordination
- `/api/pair` — Pairing exchange
- `/api/handoff/challenge`, `/api/handoff/request` — Role handoff
- `/api/secrets/challenge`, `/api/secrets/sync` — Encrypted secrets
- `/api/sync/state` — Operational state

**Does NOT sync:**
- Semantic memory (SQLite) — each machine learns independently
- Episodic memory (JSON) — local activity digests
- MEMORY.md — agent-authored

---

## 7. Explicit Handoff

**[VERIFIED]** `src/server/machineRoutes.ts:140-200+`

- `POST /api/handoff/request` with challenge verification (nonce-based)
- Challenge signed with requester's machine key
- Signature verified via public key
- Target machine reports readiness via `onHandoffRequest?: () => Promise<{ ready: boolean }>`
- On valid handoff: `onDemote?.()` pauses scheduler + stops polling
- Standby then calls `onPromote?.()` to take over

---

## 8. Network Partition

**[VERIFIED]** `src/core/HeartbeatManager.ts:224-235`

- Split-brain detection via cross-heartbeat processing
- Newer heartbeat wins (timestamp ordering)
- Failover cooldown (30 min) prevents flapping
- After 3 failovers in 24h, auto-failover **disabled** until manual reset
- Forces operator attention for persistent network issues

---

## 9. Implementation Maturity

**[VERIFIED]** Test coverage:

| Tier | Files | Examples |
|------|-------|---------|
| Unit | 6+ | `heartbeat-manager.test.ts`, `machine-identity.test.ts`, `machine-auth.test.ts`, `ThreadlineCrypto.test.ts`, `HandshakeManager.test.ts`, `multi-machine-coordinator.test.ts` |
| Integration | 3+ | `machine-routes.test.ts`, `ThreadlineIntegration.test.ts`, `TrustBootstrapIntegration.test.ts` |
| E2E | 5+ | `multi-machine-e2e.test.ts`, `multi-machine-http.test.ts`, `phase4-multi-machine-coordination.test.ts`, `ThreadlineE2E.test.ts`, `ThreadlineFullStack.test.ts` |

**Verdict**: Fully implemented with comprehensive test coverage across all three tiers. Not a stub or prototype.
