# Side-Effects Review — Machine-Coherence Guard (roadmap 4.1, F4/P0-1)

**Spec:** docs/specs/machine-coherence-guard.md (CONVERGED round 6 — 0 CRITICAL / 0 MAJOR / 0 MINOR; `review-convergence: 2026-07-03`; `approved: true` under the standing Session-A operator preapproval, topic 29836). **ELI16:** docs/specs/machine-coherence-guard.eli16.md. **Parent principle:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions. **Constitution:** Cross-Store Coherence Is an Invariant; A Dark Feature Guards Nothing; Bounded Notification Surface; Structure beats Willpower; Agent Proposes, Operator Approves.

**What this build delivers (three things, per the spec's opening):**
1. The **machine-coherence guard** — a manifest-driven skew detector over version / resolved-flag / protocol / manifest-generation, riding the existing 30s presence-pull, raising ONE deduped episode-scoped attention item from exactly ONE elected machine. Signal-only.
2. The **`awakeMachineCount` telemetry fix** (§5, ships live — corrects a lying surface, not a new behavior).
3. Updater coordination is Phase 2 (§8) — designed at sketch level, explicitly NOT built.

**Rollout posture:** the EVALUATOR + episode/alarm machinery are dev-gated dark-on-fleet / live-on-dev, dryRun-FIRST (`monitoring.machineCoherence`, `enabled` OMITTED from ConfigDefaults so `resolveDevAgentGate` decides — the #1001 anti-mechanism). The §5 bug-fixes AND the §3.2 advert EMISSION ship LIVE unconditionally (a gated advert would make the guard misdiagnose the F4 topology itself — §3.2 rationale + a pinned unit test).

---

## Build increments (committed early + often per the ~1.5h/fragile-quota directive)

### Increment A — the coherence-critical manifest (§3.1) — LANDED

**What changed:**
1. **`src/core/machineCoherenceManifest.ts` (NEW, ~360 lines)** — the pure, deterministic manifest:
   - `CoherenceCriticalFlag` interface + `COHERENCE_CRITICAL_FLAGS` (the §3.1 table): the F4 pair (ws13PinReplicate + ws13Reconcile), ws43JournalLease, ws44PoolLinks/PoolCache, the 7 WS2 stateSync stores, pollFollowsLease, sessionPool.stage (live-read, M8), exactlyOnceIngress (resolved), meshTransport.enabled, developmentAgent, and the guard's OWN posture row (N2).
   - `resolveFlagValue` — deterministic effective-value resolution per `resolution` mode (raw / dev-gate / dev-gate+dryRun) reading each entry the way its real consumer does (`readSource: boot|live`, M8) via a `CoherenceConfigView { boot, liveGet }`. Values clamped to the §3.1 alphabet.
   - `computeManifestHash` / `selfManifestHash` — sha256 over sorted ENTRIES (key+resolution+readSource, M7), 64 lowercase hex.
   - `COHERENCE_MANIFEST_EXCLUSIONS` — the explicit membership-drift exclusion list (every `multiMachine.*` DEV_GATED_FEATURES entry not in the manifest, each with a one-line reason).
   - The §3.1 clamp + byte-bound constants (`MC_MAX_ENTRIES`, `MC_FLAGS_BYTES_MAX`, `MC_MARKER_BYTES_MAX`, `MC_BLOCK_BYTES_MAX`, `MC_MARKER_ROWS_MAX`, format regexes).
2. **`tests/unit/machine-coherence-manifest.test.ts` (NEW, 21 tests)** — membership + hash determinism; the **N5 size-ratchet** (entry cap + the reference advert INCLUDING a worst-case 72-row alarm marker within the byte budgets, R3-N1); the **N5 membership-drift guard** (every `multiMachine.*` dev-gated flag is in the manifest OR explicitly excluded — a new coherence-relevant flag added without a decision fails HERE); resolution semantics both sides (dev-gate live/off, the F4 omitted-flag case, dryRun fold, force-dark false, live-read via `liveGet` M8, exactlyOnceIngress derivation, pollFollowsLease raw fold).

**Blast radius:** pure module, zero runtime wiring yet — nothing imports it in production until increment B/C. The unit test is the only consumer. No config, no route, no behavior change on the fleet.

### Increment B — advert transport (§3.2) — PENDING
### Increment C — the evaluator + episode/election/fix (§3.3/§3.4/§4) — PENDING
### Increment D — the awakeMachineCount telemetry fix (§5) — PENDING
### Increment E — integration + e2e + CLAUDE.md template + release fragment — PENDING

---

## Deviations from the spec (explicit, never silent — the standard the brief mandates)

1. **`dryRunConfigPath?` added to `CoherenceCriticalFlag`.** The spec's §3.1 interface sketch enumerates `{ key, configPath, resolution, readSource, guarantee }` but the `dev-gate+dryRun` resolution (and the "(+ dryRun)" raw rows) inherently need to know WHERE the dry-run flag lives to fold it into the effective value. Added as an optional field, documented in the module header. Behavior matches the spec's resolution semantics exactly; this is a faithful elaboration, not a semantic change.
2. **The F4 pair is TWO manifest entries, not one compound row.** The spec §3.1 table renders `ws13PinReplicate + ws13Reconcile` as one row sharing a guarantee. This build ships them as two independent entries with the same `guarantee` string, so each key is compared on its own — strictly finer-grained (never coarser) than a compound row. If either diverges independently the guard still names it.

---

## Migration parity

- ConfigDefaults OMITS the `monitoring.machineCoherence` block (the gate decides) — nothing for `migrateConfig()` to add for an omitted-`enabled` dev-gated feature with code-side `??` fallbacks. The real parity artifacts (the both-sides wiring test entry, the CLAUDE.md template triggers, the M10 awakeMachineCount template sweep) land in increments C/D/E.

## Rollback

- Increment A is inert (pure module + its test). Reverting the two new files is a clean no-op; nothing else references them yet.

## Continuation note (for a session resuming this build)

- **Landed:** increment A (manifest module + unit tests, green).
- **Next, in order:** (B) `coherenceAdvert` type on `PeerCapacity` (src/core/types.ts near the `seamlessnessFlags` block ~2035) + `SESSION_STATUS_ADVERT_FIELDS` addition + the PeerPresencePuller SECOND-enumeration fix (recordHeartbeat spread `:254` + deps type `:172` — the R2-N1 named build work) + the M4 receive clamp; emission in `refreshPool` (src/commands/server.ts:17203) UNCONDITIONAL. (C) `src/monitoring/MachineCoherenceSentinel.ts` evaluator + episode state machine + §3.4 election + §4.2.1 three-state pendingFix. (D) §5a one-liner at server.ts:17094 + §5b per-peer lease-observation map in HttpLeaseTransport + the awakeMachineCount shape sweep (D5). (E) integration/e2e + CLAUDE.md template + release fragment + architecture page.
- The spec's §9 test rows are the binding checklist; the burst-invariant (P17 flapping participant) + dead-adapter + held-offline walks are the load-bearing correctness tests.
