# Side-Effects — multiMachine.stateSync memory stores → dev-gated (topic 13481)

**Change:** Re-gate the 7 `multiMachine.stateSync.*` cross-machine memory stores
(preferences, relationships, learnings, knowledge, evolutionActions, userRegistry,
topicOperator) from `DARK_GATE_EXCLUSIONS` (off for EVERYONE, including dev agents) to
`DEV_GATED_FEATURES` (live-on-dev / dark-fleet, `dryRun:false`), mirroring the
`subscriptionPool.credentialRepointing` precedent.

**Driver:** Operator directive (Justin, topic 13481, 2026-06-13): "NOTHING should ship dark
on development agents — every multi-machine feature must be live on dev agents so it
actually gets tested, not rot." A feature shipped dark everywhere never gets exercised; the
WS2 replicated-store family was in exactly that state.

**Spec:** `docs/specs/multi-machine-replicated-store-foundation.md` (the converged + approved
spec the 7 stores were built against). This is a follow-up gating fix to the merged WS2
stores, not a new feature.

## What was wrong

The 7 stores shipped with a literal `enabled: false` in `ConfigDefaults.ts` and were
classified in `DARK_GATE_EXCLUSIONS` ("deliberate-fleet-default" — off for everyone,
including dev). That is the #1001 anti-pattern the §12.5 dark-gate lint forbids for a
dev-gated block: a written `enabled: false` literal force-darks even a development agent,
so the stores never ran ANYWHERE — they could never be dogfooded on Echo/the Mini and never
graduated.

## What changed

- `src/core/devGatedFeatures.ts` — moved all 7 entries from `DARK_GATE_EXCLUSIONS` to
  `DEV_GATED_FEATURES`, each keyed on `multiMachine.stateSync.<store>.enabled` (the wiring
  tests now prove each resolves live-on-dev / dark-on-fleet).
- `src/config/ConfigDefaults.ts` — OMIT `enabled` from all 7 store blocks so the
  developmentAgent gate decides; set `dryRun: false` (these stores replicate between the
  operator's OWN machines with no destructive write, so unlike credentialRepointing they
  need no write-safety dry-run canary — a dry-run would defeat "actually gets tested").
- `src/core/devAgentGate.ts` — NEW `resolveStateSyncStores(config)` helper: returns a new
  stores map where each store's `enabled` is the gate-resolved boolean (raw `enabled` ??
  `!!developmentAgent`), preserving every other per-store field (e.g. `dryRun`). Non-store
  foundation knobs (numbers like `maxDriftMs`) pass through untouched.
- `src/commands/server.ts` — resolve the gate ONCE at the construction boundary
  (`_stateSyncStoresResolved = resolveStateSyncStores(config)`) and feed that resolved map
  into `selfStateSyncReceive`, all 7 `new ReplicatedStoreReader({ stores })` instances, and
  `checkPoolFlagCoherence`. The funnels keep their unchanged `enabled === true` semantics —
  they now read an already-resolved boolean, so a dev agent sees a LIVE flag. This is why
  `ReplicatedStoreReader.ts`'s raw `.enabled === true` read is correct and was NOT touched.
- `src/server/routes.ts` — the `/preferences/session-context` route resolves the
  `preferences` store's `enabled` via `resolveDevAgentGate(..., ctx.config)` so the route's
  own gate and `ctx.preferencesUnionReader.isLive()` agree.
- `src/core/PostUpdateMigrator.ts` — NEW `migrateConfigStateSyncStoresDevGate(config)`:
  strips ONLY the exact old-default signature `{ enabled:false, dryRun:true }` (2 keys, that
  exact shape) per store, so `applyDefaults` backfills the new `{ dryRun:false }` and the
  gate resolves `enabled`. Any divergence (operator-set `enabled:true`, a different dryRun,
  extra keys) is treated as operator-touched and left ENTIRELY alone. Idempotent. Wired into
  the migrate path (`upgraded`/`skipped` reporting), mirroring the credentialRepointing strip.
- `tests/unit/lint-dev-agent-dark-gate.test.ts` — the 7 stateSync `enabled:`-line entries
  are GONE from the EXPECTED attribution map (the literals were removed from ConfigDefaults,
  so they have no attributed enabled:false path — exactly like credentialRepointing); the
  three cartographer entries below them shift up (1125→1100, 1170→1145, 1195→1170). Verified
  via the attributor against the edited ConfigDefaults.

## Behavioral impact

- **Dev agents (`developmentAgent: true`):** all 7 stores now resolve LIVE and `dryRun:false`
  — replication genuinely runs so the family is dogfooded. Replication is between the
  operator's OWN machines only: NO external egress, NO third-party spend. The PII stores
  (relationships, userRegistry, topicOperator) carry the same at-rest honesty already
  documented — at-rest plaintext per machine, transit-encrypted; an inbound-principal
  RESOLUTION and "who is my verified operator?" stay LOCAL-authoritative (a replicated record
  is untrusted advisory data). Fully reversible: the foundation's rollback-unmerge atomically
  drops a peer's contribution on disable.
- **Fleet (`developmentAgent` unset/false):** UNCHANGED — all 7 stores resolve dark, a
  strict no-op, exactly as before. A single-machine agent is a no-op regardless.
- **Reversibility:** set an explicit `multiMachine.stateSync.<store>.enabled: false` in
  config to force-dark even a dev agent; an explicit `true` is the documented fleet-flip.

## Migration parity

`applyDefaults` is add-missing-only deep-merge, so a new agent gets the omitted-`enabled` /
`dryRun:false` shape via `init`. Existing agents that already received the old
`{ enabled:false, dryRun:true }` per store would, under add-missing-only, keep that stale
shape (explicit values are not overwritten) and stay dark even on a dev agent — so
`migrateConfigStateSyncStoresDevGate` strips the exact old-default signature on update,
letting the gate resolve and `applyDefaults` backfill `dryRun:false`. An operator's
hand-edited block (any divergence from the exact signature) is never touched — reach is not
authority. The migration is idempotent (a second run finds nothing default-shaped to strip).

## Tests

Unit: `state-sync-stores-dark-gate` (40), `PostUpdateMigrator-stateSyncStoresDevGate` (7),
the 5 ws2x wiring tests (ws22/23/24/25/26), `lint-dev-agent-dark-gate` (line-map recomputed),
`no-silent-fallbacks`, `feature-delivery-completeness` — all green locally. Typecheck clean
(`tsc --noEmit` exit 0). The full unit suite is left to CI (it is the authority).
