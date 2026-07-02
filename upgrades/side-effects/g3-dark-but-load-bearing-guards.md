# Side-Effects Review — G3 Dark-but-Load-Bearing Guard Classification

**Version / slug:** `g3-dark-but-load-bearing-guards`
**Date:** `2026-07-01`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/g3-dark-but-load-bearing-guards.md` (review-convergence 2026-07-02, 6 iterations, cross-model codex GPT-5.5; approved:true)
**Parent principle:** A Dark Feature Guards Nothing (STANDARDS-REGISTRY.md, ratified 2026-07-01 PR #1316)
**Second-pass reviewer:** not-required (Tier 2; observe-only classifier + one PIN-gated suppress route; no new gating/blocking decision, byte-identical `/guards` for a consumer ignoring the new fields)

## Summary of the change

The `/guards` inventory could not express "this dark feature is load-bearing" — a
feature that ships DARK but that a CRITICAL PATH depends on was indistinguishable
from a genuinely-optional dark feature. It sat quiet while the path it should guard
ran unguarded (the 2026-07-01 silent-loss postmortem's case study: operator message
delivery depended on dark guards, and nothing surfaced it).

G3 adds an optional `loadBearing`/`criticalPath`/`soakWindowDays`/`declaredLoadBearingAt`
manifest declaration and classifies a load-bearing guard in a silent-unguarded posture
into ONE of three states — `loadBearingGap` (loud, its OWN attention channel),
`loadBearingSoaking` (graduate arm, no attention item), `loadBearingAccepted` (owned,
PIN-authenticated operator acceptance). `criticalPath` travels on EVERY anomaly of a
load-bearing guard. Pure classifier, observe-only — it never gates.

### Files added
- `src/monitoring/guardAcceptedFallbacks.ts` — ALL disk I/O for the per-machine
  operator-accept store (`state/guard-accepted-fallbacks.json`, keyed
  `<machineId>:<guardKey>`). Keeps the classifier PURE: the caller reads/scopes
  once and threads the map in. Missing/corrupt file ⇒ empty map (safe direction).
- Tests: `tests/unit/monitoring/guard-posture-loadbearing.test.ts`,
  `tests/unit/monitoring/guard-posture-probe-loadbearing.test.ts`,
  `tests/integration/guards-accept-fallback-route.test.ts`,
  `tests/e2e/guards-loadbearing-lifecycle.test.ts`,
  `tests/unit/PostUpdateMigrator-guardLoadBearingSection.test.ts`.

### Files modified
- `src/monitoring/guardManifest.ts` — 4 optional fields; the two NEW manifest lints
  (`validateGuardManifest`); the curated initial load-bearing set (inboundQueue +
  strandedTopicSentinel, both operator-message-delivery critical-path, 30-day soak
  window declared 2026-07-01).
- `src/monitoring/guardPostureView.ts` — the SIX new row fields + three-state
  precedence (accepted → soaking-within-window → gap) on a threaded `now`; both
  `deriveGuardRow` and `buildGuardInventory` stay PURE (accept map threaded via
  `DeriveInput`/`opts`); `ROW_FIELD_ALLOWLIST` extended with all six by name; summary
  + heartbeat gain the three key-lists.
- `src/monitoring/probes/GuardPostureProbe.ts` — the SEPARATE `load-bearing-gap`
  episode track (own `openEpisodeId`/`episodeEmitted`/anomalies + item-id namespace
  `guard-posture-loadbearing:ep-N`); acute close condition tests `currentAcute` (not
  the shared set); `load-bearing-gap` class pushed in both evaluate paths; criticalPath
  on all load-bearing anomalies; `alertLoadBearingGaps` sub-flag (default-on).
- `src/core/types.ts` — the 3 optional key-list fields on `GuardPostureSummary`.
- `src/server/routes.ts` — GET /guards threads the accept map + now; the PIN-gated
  `POST`/`DELETE /guards/:key/accept-fallback` route (owner+reason required).
- `src/commands/server.ts` — all 3 `buildGuardInventory` call sites thread the accept
  map + now (route, probe `getLocalPosture`, heartbeat `selfGuardPosture`); the probe's
  `alertLoadBearingGaps` sub-flag resolved from config (default true).
- `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` — Agent Awareness +
  Migration Parity (content-sniffed on `loadBearingGap`).
- `src/data/state-coherence-registry.json` — the new `guard-accepted-fallbacks`
  store category + a `resolution`-class retention policy.

## Decision-point inventory

- **Added — one PIN-gated route** (`POST/DELETE /guards/:key/accept-fallback`): the
  ONLY new decision surface. It SUPPRESSES a safety SIGNAL for a named operator; it
  never allows/blocks an action. Gated by `checkMandatePin` (Know Your Principal — a
  Bearer token cannot accept a safety risk); `owner` AND `reason` both REQUIRED (400
  otherwise); a non-load-bearing key is 404.
- **Added — classifier flags**: `deriveGuardRow` sets orthogonal FLAGS; the nine
  `GuardEffectiveState` values + the normative precedence table are UNCHANGED. No new
  effective state, so the nine-state contract cannot regress.
- **Added — probe anomaly class** `load-bearing-gap` on its OWN episode track.
  Observe-only: the probe only ever calls the attention funnel; never gates.
- No agent-to-user message-flow gate is added.

## Roll-up across the seven review dimensions

1. **Over-block**: none. The classifier adds flags; `/guards` is byte-identical for a
   consumer ignoring the new fields. The accept route only suppresses a signal — it
   loosens nothing and blocks nothing. The alert has a rollback sub-flag
   (`alertLoadBearingGaps:false`) that keeps the classification.
2. **Under-block**: none. No gate was loosened. A load-bearing dark guard is now MORE
   visible, not less. Soaking only defers the alert within a bounded, code-constant
   window; a typo'd `declaredLoadBearingAt` falls to the LOUD gap (safe direction).
3. **Masking**: the round-3/round-4 fix. `load-bearing-gap` is a designed long-lived
   anomaly; running it on a SEPARATE episode track (its own item-id namespace) means a
   week-open gap can never hold the acute track's episode open. The regression test
   drives the REAL `createAttentionItem` funnel and asserts an acute off-runtime-divergent
   surfaces while the lb episode is open; the inert-lever test proves the funnel dedups
   by ID, so a healthKey-only split would leave masking intact.
4. **Multi-machine**: classification is per-machine (an accept on machine A never
   silences a peer's gap — proven by test). Manifest fields are fleet-uniform constants;
   a peer's criticalPath is looked up from the local manifest. The heartbeat carries the
   three key-lists (Array.isArray-guarded for an un-upgraded peer). The 3rd-site fix: the
   heartbeat compute threads the local accept map, so an accepted guard never ships to
   peers as a false gap.
5. **Purity / I/O layering**: `deriveGuardRow` AND `buildGuardInventory` gain no `fs`.
   The caller reads the accept file ONCE per inventory build and threads the scoped map;
   the new `guardAcceptedFallbacks.ts` module owns all disk I/O. One accept-file read per
   inventory build, never per guard.
6. **Bounded Notification Surface**: each track surfaces as ONE bounded, coalesced,
   per-episode class-level forum topic (two class-level topics max, never per-guard).
   Soaking pushes NO attention item.
7. **Migration Parity / Agent Awareness**: the manifest ships as code (reaches existing
   agents automatically); the CLAUDE.md vocabulary + accept route reach existing agents
   via a content-sniffed `migrateClaudeMd` addendum; new agents get it in `generateClaudeMd`.
   Migration idempotency + parity covered by a dedicated test.

## Rollout / rollback

Classification + route + separate-track wiring ship ALWAYS-ON as pure observability
(additive, never gating). The probe ALERT on `load-bearing-gap` rides the existing
GuardPostureProbe enablement + the `monitoring.guardPostureProbe.alertLoadBearingGaps`
sub-flag (default-on; soak windows are code constants). Rollback = set the sub-flag
false; `/guards` keeps the classification. The accept store is a per-machine JSON file;
DELETE scopes to the operator record only, never the manifest soak constant.

## Test evidence

`npx tsc --noEmit` clean; full `npm run lint` exit 0. New tests green: 21 unit
(classification/lints/allowlist/key-lists/purity), 9 probe-track unit (separate track,
masking regression against the real funnel, inert-lever guard, soaking-silent,
criticalPath, heartbeat array-guard, per-machine independence, alert rollback), 7
integration (PIN gate, owner-required, accept clears gap, DELETE-revoke survives reboot),
3 e2e (feature-alive: six fields + accept route mounted). Existing guard/posture suites
(monitoring 260, guard integration+e2e 51, server+migrator 27, parity+discoverability 170)
all pass.
