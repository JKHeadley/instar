# Side-effects review — WS5.2 Step 7 (credential re-pointing routes + audit-scrub chokepoint)

**Spec:** `docs/specs/live-credential-repointing-rebalancer.md` (approved:true, converged) §2.4/§2.9/§0.g, build-plan §7.
**Tier:** 2 (src code + HTTP routes; ships DARK behind the EXISTING `subscriptionPool.credentialRepointing` flag — no new gate).
**Parent principle:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions.

## What changed

- **NEW `src/core/CredentialAuditEmit.ts`** — the SINGLE secret-scrub chokepoint (`scrub`/`scrubString` + a `CredentialAuditEmit` handle). Every `logs/credential-swaps.jsonl` write, every `/credentials/*` response body, and every attention-item routes through it; it deep-walks records and redacts token-shaped runs via the existing `redactToken` (CredentialProvider.ts:56 — reused, not re-authored).
- **NEW `src/core/CredentialRestoreEnrollment.ts`** — `classifyRestoreCoherence`: the identity-coherence decision (access-tenant == refresh-lineage). Incoherent / unparseable / refresh-token-less / oracle-unavailable → one-directional park verdict (never exchanged into a healthy slot).
- **NEW `src/core/CredentialManualLevers.ts`** — per-pair cooldown + §0.g `force:true` budget (`maxForcedManualSwapsPerWindow`). Surfaced refusals, never silent.
- **`src/commands/server.ts`** — constructs the live `CredentialSwapExecutor` (the Step-5 residual "nothing constructs the executor live yet" closes here), the audit emit (jsonl sink + telegram attention), the composed oracle→pool `resolveIdentity`, and the levers; passes the `credentialRepointing` bundle to AgentServer.
- **`src/server/routes.ts`** — registers `POST /credentials/swap|set-default|restore-enrollment` (Bearer), `GET /credentials/locations` (census #11), `GET /credentials/rebalancer` (503 in Increment A). Every response sent through `audit.response(...)`.
- **`src/server/AgentServer.ts`** — threads the `credentialRepointing` bundle option → routeCtx.
- **`src/server/CapabilityIndex.ts`** — registers the `/credentials` prefix + endpoints.
- **`src/core/types.ts`** — adds `maxForcedManualSwapsPerWindow?` + `forcedManualSwapWindowMs?` config knobs (NUMBER knobs — NO `enabled: false` literal, so the dark-gate line-map is UNCHANGED, verified 16/16 clean).
- **`site/src/content/docs/architecture/under-the-hood.md`** — documents `CredentialAuditEmit` (the new exported class; ≥2 mentions for docs-coverage).

## State files / migrations

- Writes `logs/credential-swaps.jsonl` (size-rotation is Increment B; Step 7 appends). No new schema; reuses the Step-2 `credential-locations.json` ledger.
- **No migration in Step 7.** CLAUDE.md awareness template + `migrateConfig`/`migrateClaudeMd` are explicitly scoped to **build-plan §9 (Step 9 — Migration parity)** — tracked there, not deferred silently. The new config knobs are optional with code-level defaults, so an existing agent with no value behaves identically.

## Blast radius / reversibility

- **Ships DARK.** Every lever 503s/no-ops while `subscriptionPool.credentialRepointing.enabled` is false (always, fleet-wide). The executor's own two-flag gate (`enabled`+`dryRun`) makes it a strict no-op too. E2E proves byte-for-byte today's behavior with the flag off.
- A wrong swap is a reversible, oracle-verified permutation (spec §2.4 supervision Tier 0); no token material is ever returned (the scrub chokepoint).
- `rebalancer` is 503 in Increment A — the autonomous balancer is Increment B; the route exists + is discoverable now.

## Adversarial review (4 lenses, folded as named tests)

1. **secret-leak-via-audit (THE blocker)** — `scrub` redacts on all 3 surfaces; named test feeds a real-shaped `sk-ant-…` token through jsonl/response/attention and asserts the token core appears in NONE; integration + e2e also assert no token in a response body. Wiring: the route's `credSend` is the only response path and it routes through `audit.response`.
2. **restore-enrollment poison** — `classifyRestoreCoherence` parks Frankenstein/unparseable/refresh-token-less/oracle-down one-directionally; integration test asserts an incoherent slot is parked, never exchanged.
3. **auth boundary** — every POST lever + the GET reads 401 without Bearer (integration + e2e named tests); rebalancer 503 dark.
4. **dark-ship inertness** — flag OFF → 503 on every lever (e2e strict-no-op test, the single most important test).

## Silent-fallback tags

Every new catch is tagged `@silent-fallback-ok` with justification (audit-write best-effort, attention best-effort, cache-bust best-effort, unparseable-blob → coherence-park). no-silent-fallbacks + no-empty-catch-blocks tests pass; no baseline bump needed.
