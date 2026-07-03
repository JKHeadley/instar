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

### Increment D₁ — version telemetry populated (§5a) — LANDED

**What changed:** `src/commands/server.ts` — the sole `captureHardware()` callsite (~:17458) now passes `ProcessIntegrity.getInstance()?.runningVersion`. When ProcessIntegrity is unavailable the argument is `undefined` (OMITTED), so `hardware.instarVersion` stays honestly absent (L1) — never a possibly-stale `config.version`.

**Blast radius:** ships LIVE (a bug-fix — correcting a field that was structurally always `undefined`, not a new behavior). Retroactively activates the already-written consumer at `src/server/routes.ts:6645/6671` (the peer-version annotation on `/guards?scope=pool` failure rows). Additive: `hardware.instarVersion` was optional and always undefined before; now populated on machines running this version. No shape change (that is §5b's D5, still pending).

### Increment B — advert transport (§3.2) — LANDED

**What changed:**
1. **`src/core/machineCoherenceAdvert.ts` (NEW)** — the §3.2 advert block:
   - `CoherenceAdvert` / `CoherenceAlarmMarker` / `CoherenceAdvertRejection` types (instarVersion, protocolVersion, manifestHash, guard posture N2, FORENSIC-ONLY beatSeq R2-L1, manifest-resolved flags, optional alarm marker R2-M1/M2).
   - `buildCoherenceAdvert` — pure builder over the increment-A manifest (`buildCoherenceFlags` + `selfManifestHash` + `selfProtocolVersion`); `resolveSelfGuardPosture` maps the manifest's own-posture row to `live | dry-run | dark`.
   - `clampCoherenceAdvert` — the **M4 receive clamp (NEW BUILD WORK per spec)** with the R5-N3 format clamps: version alphabet, 64-lowercase-hex manifestHash, guard enum, numeric protocol/beatSeq, flag key/value alphabets + entry cap, the §3.1 byte budgets measured on the REBUILT serialization (R4-L4). Failure directions per spec: malformed ADVERT → named rejection (rejected ≠ absent); malformed alarm MARKER (episodeId format R3-N9 / row-hash format) → marker dropped with named reason, advert STANDS; >72-row marker → truncated + `rowsTruncated` (honesty only — truncation never grants coverage, R3-M4).
2. **`src/core/types.ts`** — `MachineCapacity` gains `coherenceAdvert` + `coherenceAdvertReceivedAt` (receiver-stamped, M5) + `coherenceAdvertRejected` (M4), siblings to `seamlessnessFlags`/`guardPosture`.
3. **`src/core/MachinePoolRegistry.ts`** — `HeartbeatObservation` gains both fields; `recordHeartbeat` tracks advert receipt SEPARATELY (the posture pattern): an advert-carrying beat stamps a fresh receipt + clears any standing rejection; a rejection-carrying beat REPLACES the advert for evaluation (last-good retained internally for forensics only); a sparse beat carries BOTH forward unchanged — carry-forward can never impersonate freshness (M5). `assemble` exposes rejection-over-advert.
4. **`src/core/PeerPresencePuller.ts`** — `PeerCapacity` gains both fields; `coherenceAdvert` added to `SESSION_STATUS_ADVERT_FIELDS` (the ratchet covers the narrowing from day one); `narrowSessionStatusToPeerCapacity` applies the clamp AT the narrowing step (the spec's designated clamp point); the **R2-N1 second enumeration** closed — `pullOnce`'s hand-maintained `recordHeartbeat` spread + its deps type carry both fields (the #930-class 5th-instance guard).
5. **`src/commands/server.ts`** — `refreshPool` emits the advert on EVERY self beat, **UNCONDITIONALLY (M3, normative)** — no dev-gate on emission; `beatSeq` closure counter; `instarVersion` from `ProcessIntegrity.runningVersion`; `liveGet` wired to `liveConfig.get` so `readSource:'live'` entries (sessionPool.stage, exactlyOnceIngress) re-advertise within one beat of a PATCH /config with no restart (M8). Builder faults degrade to an advert-less beat (never a dead heartbeat). Alarm marker is increment C's to attach (no episode machinery exists yet).
6. **Tests (green):** `tests/unit/machine-coherence-advert.test.ts` (NEW, 22 tests — M3 fleet-config emission, guard-posture ladder, clamp accept/reject matrix incl. marker-drop + truncation, registry receipt/carry-forward/rejection-replace semantics) + `tests/unit/peer-presence-puller.test.ts` extended (ratchet fixture carries a clean advert; R2-N1 spread tests both directions; M4 narrowing clamp pass/reject).

**Blast radius:** the advert is an ADDITIVE optional heartbeat field (the same additive-advert path every prior field took — peers without the code ignore it). Ships LIVE by design (M3): every machine on this version emits ~1–2 KB more per 30s self-beat and stores peers' clamped adverts in the in-memory registry. No route, no alarm, no evaluator yet — nothing CONSUMES the advert until increment C, so fleet behavior is unchanged beyond the heartbeat payload. Rejection markers are data-at-rest only until C classifies them.

### Increment C₀ — evaluator PURE helpers (§3.3 classification + N1 identity) — LANDED

**What changed:** `src/monitoring/machineCoherenceEvaluate.ts` (NEW, pure, zero wiring — the increment-A pattern): `classifyPeer` (compared / unknown / advert-stale / advert-rejected, each class's pinned handling; rejection wins over a co-existing advert; an unparseable receipt time degrades — never trusts), `skewRowIdentity` (the N1 canonical `dimension|key|sorted(machineId=valueClass)` key that confirmation counters, episode membership, the §4.5 damper, and the latches all key on), `rowIdentityHash` (the §3.2 marker wire format — first 16 lowercase hex of sha256; content-free), `classifyVersionSkew` (none / patch-only-grace-gated / major-minor; an unparseable-but-differing version takes the QUIETER grace path — never cries wolf), `electRaiser` (§3.4: lease-holder-if-candidate else lowest machineId; zero candidates → null; pure over shared inputs so every machine computes the same result). Tier 0 supervision (N6) noted in-module. 24 unit tests (`tests/unit/machine-coherence-evaluate.test.ts`) — both sides of every boundary incl. the at-bound staleness edge and the no-mutation election property.

**Blast radius:** pure module; the tests are the only consumer until the sentinel (C₁) composes it.

### Increment C₁a — sentinel evaluator core: config + gates + classification tick + election — LANDED

**What changed:**
1. **`src/monitoring/MachineCoherenceSentinel.ts` (NEW)** — the evaluator core composing the C₀ pure helpers:
   - `resolveMachineCoherenceConfig` — the full §7 config surface with code-side `??` defaults; `enabled` resolves through `resolveDevAgentGate` (OMITTED from ConfigDefaults — the #1001 anti-mechanism; explicit value wins); `dryRun` defaults TRUE (dry-run FIRST even on dev). `selfPostureOf` → live/dry-run/dark.
   - `tick()` — rides the caller's cadence (the 30s peerPresenceTick, wiring pending): single-machine STRICT no-op (short-circuits below 2 online members BEFORE touching state), per-machine classification via `classifyPeer` (M11 universe honesty — every online machine accounted), §3.4 election via `electRaiser` (self candidacy from LOCAL resolved config — authoritative over its own advert echo; peers from their adverts' `guard`), fail-toward-silence (any error → counter, no emit). `inWarmup()` exposes the N8 window for the Session-B confirmation counters.
   - `status()` — the §6 snapshot core (enabled/dryRun/lastTickAt/universe counts/classification counts/raiser/openEpisode:null/counters).
2. **`src/core/devGatedFeatures.ts`** — `machineCoherence` registered (`monitoring.machineCoherence.enabled`), auto-covered by the both-sides wiring test (145 green). Justification: signal-only, Tier 0, no spend/egress, dry-run-first, single-machine no-op.
3. **`src/monitoring/guardManifest.ts`** — GUARD_MANIFEST entry (`monitoring.machineCoherence.enabled`, `component: 'MachineCoherenceSentinel'`, NOT loadBearing per D6, `expectRuntime: false` FOR NOW — C₁b adds the server-boot construction + `guardRegistry.register` callsite and flips it to true; the lint-guard-manifest classification standard required the entry the moment the guard-shaped component existed).
4. **Tests:** `tests/unit/MachineCoherenceSentinel.test.ts` (NEW, 13) — gate ladder both sides + explicit-wins, §7 defaults + overrides, single-machine no-op, offline exclusion, M11 classification counts, holder-vs-standby SAME-raiser property, dry-run self/peer non-candidacy, fail-toward-silence, warm-up window, openEpisode-never-fabricated.

**Blast radius:** pure module + one registry data entry; NOTHING constructs the sentinel in production yet (server wiring is C₁b). Fleet behavior unchanged.

### Increment C₁b-i — server-boot wiring + peerPresenceTick rider — LANDED

**What changed:**
1. **`src/monitoring/MachineCoherenceSentinel.ts`** — added `guardStatus()`: the synchronous GuardRegistry runtime getter (`{ enabled, dryRun, lastTickAt }`, GUARD-POSTURE-ENDPOINT-SPEC §2.1). `lastTickAt` is 0 before the first tick so a constructed-but-never-ticking guard reads `on-stale`, never "on".
2. **`src/commands/server.ts`** — server-boot construction on the mesh peer-presence path (right before the `peerPresenceTick` closure, where `machinePoolRegistry` / `meshSelfId` / `leaseCoordinatorRef` / `guardRegistry` are all in scope, mirroring the StrandedTopicSentinel exemplar): constructs the sentinel ONLY when `resolveMachineCoherenceConfig(config).enabled` (dark guard → never constructed → route 503s, no tick), wires deps (`listCapacities`→pool registry, `selfMachineId`→`meshSelfId`, `leaseHolderMachineId`→`leaseCoordinatorRef.currentHolder()` else null, `now`→`Date.now`), `guardRegistry.register('monitoring.machineCoherence.enabled', …guardStatus())`, and a §6 boot line (`enabled dryRun=… manifestHash=… flags=…`). The `peerPresenceTick` closure now calls `machineCoherenceSentinel?.tick()` inside its own try/catch (fail toward silence) — the 30s rider, no new timer. Own try/catch around construction: a wiring failure is logged non-fatal (never crashes boot).
3. **`src/monitoring/guardManifest.ts`** — flipped the machineCoherence entry `expectRuntime: false → true` (the register callsite now exists). Comment pins the safety: `missing` requires `configEnabled === true` (guardPostureView precedence), so a dark FLEET agent (gate → false) never constructs, never registers, and is never falsely graded `missing` — the ws13Reconcile/holdForStability `expectRuntime:true` precedent.
4. **Tests:** `tests/unit/MachineCoherenceSentinel.test.ts` +3 (guardStatus shape + GuardRuntimeStatus conformance; lastTickAt 0→NOW after a tick; dev dry-run-first / fleet-dark posture mirror) = 16. `tests/unit/lint-guard-manifest.test.ts` +3 (single classification, `expectRuntime:true` + fleet-default-false + 30s cadence + not-loadBearing, real lint stays clean) = 17. The both-sides dev-gate wiring test (`devGatedFeatures-wiring.test.ts`) already auto-covers the machineCoherence entry (145 green).

**Blast radius:** dev-agent only (gate live-on-dev / dark-on-fleet). On a dev agent with mesh, the sentinel now constructs, registers in `/guards` (graded `on-dry-run` while `dryRun:true`), and ticks every 30s — classification + election only (no confirmation, no episode, no item yet; those are C₁b-ii onward). Fleet + single-machine-non-mesh agents unchanged (never constructed).

### Increment C₁b-ii — dimension comparison + confirmation counters (§3.3 R2-L3 + M6) — LANDED

**What changed:**
1. **`src/monitoring/machineCoherenceEvaluate.ts`** — `SkewRow` interface + `computeDivergentRows(compared)`: the PURE per-tick dimension comparator. Emits one `SkewRow` per divergent dimension across the COMPARED machines: **flag** (manifest-INTERSECTION keys only — a key on one side alone is version skew, not flag skew), **version** (`instarVersion` not all equal; severity = `major-minor` if ANY pair differs in major.minor else `patch-only`), **manifest** (`manifestHash` differs WHILE every `instarVersion` is identical — M7 same-version dirty-dist), **protocol** (`protocolVersion` differs). Each row's `identity` is the N1 `skewRowIdentity` (content-free: ids + clamped value classes) so two evaluators over the same shared adverts compute the SAME identity (the §3.4 duplicate-reconciliation / marker-key convergence property). `clampValueClass` clamps every scalar to `[a-z0-9-]{≤32}`.
2. **`src/monitoring/MachineCoherenceSentinel.ts`** — the §3.3 confirmation engine wired into `tick()` (`updateConfirmation(nowMs)` after the election):
   - Per-row `RowConfirmState` map keyed on the N1 identity (`consecutiveTicks`, `firstSeenAtMs` grace clock, `confirmed`).
   - **R2-L3 consecutive rule**: a row's counter increments ONLY when its identity was present LAST tick (`lastTickRowIds`); a row whose identity was absent (re)starts at 1 with a fresh grace clock. Because a participant dropping out (offline/unknown/stale) or a pair equalizing either vanishes or changes the identity, one flapping reading can never accumulate toward confirmation. Rows absent this tick are dropped.
   - **Confirmation predicate**: patch-only version rows confirm on the `versionSkewGraceMs` CLOCK (continuous skew ≥ 45 min); every other dimension (flag / major-minor version / manifest-class / protocol) confirms at `flagConfirmTicks` (default 2) consecutive ticks.
   - **M6 update-wave suppression**: FLAG rows are filtered out while ANY `instarVersion` skew is present among the compared machines (an update that shifts a flag's resolved default would else alarm HIGH mid-wave and auto-resolve); once versions agree, residual flag skew confirms normally.
   - **Fail-toward-silence hardening**: an error tick leaves the confirmation state INTACT (a transient pool-read fault must not fabricate a participant-drop reset); the single-machine no-op clears the whole engine (below 2 members, no divergence is possible).
   - `confirmedSkewRows()` / `pendingSkewRows()` pure reads (Session B's episode machinery + the status route consume these); `status().counters` gains `skewsConfirmed` (cumulative transitions), `confirmedRows` + `pendingRows` (live gauges).
3. **Tests (green):** `tests/unit/machine-coherence-evaluate.test.ts` +9 (`computeDivergentRows` describe — <2 no-op, all-agree, flag row = skewRowIdentity, intersection-only flags, version severities both sides, manifest-only-when-versions-identical, protocol, N1 determinism); `tests/unit/MachineCoherenceSentinel.test.ts` +5 confirmation-engine (2-tick flag confirm, R2-L3 flap reset, M6 suppress-then-confirm, patch-only grace-clock, below-2 clears) + the two counter-shape updates. 54 targeted tests green; `tsc --noEmit` clean.

**Blast radius:** dev-agent only (the sentinel is only constructed on a live-gate dev agent from C₁b-i). Adds per-tick divergence classification + confirmation accounting to the 30s rider — still SIGNAL-ONLY (no episode, no attention item, no alarm marker; those are C₁b-iii onward). Fleet + single-machine unchanged (never constructed).

### Increment C₁b (remainder) — episode/alarm machinery — PENDING
Remaining, in order: (iii) the §4 episode state machine (N7 state file, N3/N4 corrupt-state) + the ONE attention item (§4.2 verbatim body) + §3.4 takeover/fallback/reconciliation + alarm-marker attach into refreshPool's advert; (iv) §4.2.1 pendingFix flow; (v) `GET /pool/machine-coherence` status route (503-when-dark) + `logs/machine-coherence.jsonl` + the `clampRejections`/marker-drop counters.
### Increment D₂a — per-peer lease-observation map (§5b's NEW retained state) — LANDED

**What changed:**
1. **`src/core/HttpLeaseTransport.ts`** — `lastPulledByPeer: Map<peerMachineId, { lease, observedAtMs }>` recorded inside `pullPeer()` from the SAME dials it already makes (zero new network traffic), keyed on the DIALED peer's machine-auth-verified registry id — NEVER the response body's holder claim (a pulled lease naming a third machine is hearsay; it never mints a row for the third machine). A confirmed no-lease pull records an honest `null`; an UNCONFIRMED dial records nothing (the stale entry ages out via the counting rule's freshness bound). Pruned in `pullAllPeers()` when a peer leaves the peer set. Exposed as `observedByPeer()` (a copy).
2. **`src/core/LeaseCoordinator.ts`** — `LeaseTransport` interface gains optional `observedByPeer?()`; surfaced as `LeaseCoordinator.peerLeaseObservations()` (empty map on a git-only mesh — the counting rule degrades to `'registry-roles'` there).
3. **Tests:** `tests/unit/HttpLeaseTransport.test.ts` +5 (§5b describe): dialed-id keying vs third-machine hearsay, honest-null observation, unconfirmed-dial non-refresh, de-pair pruning, copy semantics.

**Blast radius:** additive retained state + two read surfaces; NOTHING consumes them yet (the counting-rule rework is D₂b). Advisory data only (L4/SEC-4) — never demotion authority.

### Increment D₂b — the awakeMachineCount counting rule + shape rework (§5b, D5) — PENDING
(The counting rule in `MultiMachineCoordinator.getSyncStatus` — self `holdsLease()` + fresh/live/self-claim peers; `number | null` + `awakeMachineCountSource` tag; the FULL consumer/test/template/docstring sweep the D5 decision mandates in the same PR: docstring, /health + GET /pool serializers + the two other route callers, multimachine-syncstatus + split-brain e2e + pool-routes tests, the two CLAUDE.md template mentions via generateClaudeMd + migrateClaudeMd, doctor + machine list labels (M12), upgrade-guide entry.)
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
