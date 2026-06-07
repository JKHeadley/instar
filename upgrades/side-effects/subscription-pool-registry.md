# Side-Effects Review — SubscriptionPool Registry (P1.1)

## Scope of change

New self-contained registry + CRUD routes + wiring. Files:
- `src/core/SubscriptionPool.ts` (new) — the registry class + types.
- `src/server/routes.ts` — 5 new `/subscription-pool` routes + RouteContext field.
- `src/server/AgentServer.ts` — threads `subscriptionPool` option → RouteContext.
- `src/commands/server.ts` — instantiates the pool, passes it to AgentServer.
- `src/server/CapabilityIndex.ts` — classifies the prefix as INTERNAL.
- tests (unit/integration/e2e).

## Mutability / authority analysis

- **No new authority.** The registry is passive metadata. It does not gate, block, spawn, kill, message, or call any external service. It cannot influence routing, session lifecycle, or any existing behavior. Nothing reads the pool yet (the scheduler that will is P1.3).
- **Filesystem writes** are confined to a single file, `<stateDir>/subscription-pool.json`, via atomic tmp+rename. No deletes of anything pre-existing; no writes outside the agent state dir.
- **No network calls.** P1.1 does not poll the quota endpoint or contact any provider. (That is P1.2.)
- **No process/session effects.** Does not touch tmux, sessions, the reaper, or spawning.

## Credential-handling threat model (the load-bearing concern)

- The registry **must never store tokens.** Enforced structurally: `add()` and `update()` scan input (including the raw request body) for credential-bearing field names (accessToken/refreshToken/token/apiKey/secret/password/oauth/credential[s]) and throw `ValidationError` → HTTP 400. Verified from both sides by unit + integration tests.
- Only the login **location** (config home path) is persisted. A leaked `subscription-pool.json` therefore leaks nicknames + config-home paths, never a usable credential.
- This aligns with Anthropic's enforced ToS position (Claude OAuth tokens may only be used by the official Claude Code client): instar will drive each account through its real client pointed at the config home — it never extracts a token. The registry storing only the location keeps that invariant structural.

## Failure modes considered

- **Corrupt store file** → `load()` starts fresh (no credentials are lost because none are stored). Covered by a test.
- **Concurrent writes** → per-record `version` counter supports optimistic CAS for the later scheduler; P1.1 is single-writer (server process) so no contention today.
- **Persist failure** (disk full / EPERM) → `@silent-fallback-ok`: in-memory store remains authoritative, next write retries. Matches the CommitmentTracker pattern.
- **Unknown/duplicate/empty inputs** → rejected with 400 + a specific message; covered both sides.

## Blast radius if this is wrong

Minimal. Dark + additive + agent-invisible + no authority. Worst realistic case: a malformed account row in one JSON file, which the operator can delete; no live behavior depends on the pool until later phases wire a consumer.

## Migration / parity

None required. No config defaults, hooks, skills, or CLAUDE.md template changes. The route ships via dist on update. The capability is deliberately not surfaced to agents yet (graduates with P1.3/P2.1).

## Tier rationale

Declared Tier 1 despite the structural risk-floor signal (new route + new exported class). The signals are present but the *actual* risk is low: ships dark, adds no authority, mutates no existing behavior, single confined state file, full three-tier test coverage, and the design was reviewed + decided by the operator (topic 20905) before build. The below-floor declaration is recorded for audit per the gate's design (the mind holds authority).
