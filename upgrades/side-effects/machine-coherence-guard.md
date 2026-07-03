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

### Increment C₁b-iii-a — episode DURABLE state layer (§4.1 + §4.6) — LANDED

**What changed:**
1. **`src/monitoring/machineCoherenceEpisode.ts` (NEW, pure types + fs primitives)** — the durable state layer the §4 state machine consumes (the established pure-module-first rhythm; nothing raises/transitions here):
   - Types faithful to §4.1–§4.6: `EpisodeState` (episodeId, openedAtMs, skewRowIdentities N1 set, itemRaisedAt R4-M1, attentionItemId, predecessorEpisodeId R2-M2, durable `suspended`/`suspendReason`, durable `operatorAck` R4-N2, `pendingFix`, `escalationAppended`, `reopenCount`), `PendingFix` (the three-state `proposed`/`approved-holding`/`executing-verifying` lifecycle R3-M6, proposal hash+message-id AUTHORITY, verify-clock anchors + `accumulatedSuspendedMs` R5-L1), `RecurrenceBlock` (the R2-N2 sibling that OUTLIVES episode close — newItemTimestamps per-day cap, recentlyClosed reopen-window memory, reopenLatch, shared appendBudget), `EpisodeCloseReason` (the §4.3 taxonomy — only `restored` claims restoration), `EpisodeFile` on-disk shape.
   - `mintEpisodeId(openedAtMs)` → `mc-<ms>` (N4); `episodeStatePath(stateDir)` → `<stateDir>/state/machine-coherence-episode.json` (N7 per-agent, never global); `emptyRecurrence()`.
   - `readEpisodeFile(stateDir)` → `{ status: 'absent' | 'ok' | 'corrupt' }` — distinguishes missing (fresh) from structurally-invalid (§4.6 re-baseline gate, the GuardPostureProbe pattern): bad JSON / wrong version / missing-or-malformed shape returns a NAMED corrupt reason, never a throw and never a silent `{}`.
   - `writeEpisodeFile(stateDir, file)` — atomic tmp+rename mirroring `writeConfigAtomic` (`BootSelfKnowledge.ts:112`); creates the `state/` subdir; callers write on TRANSITIONS only (R2-N3).
2. **Tests (green):** `tests/unit/machine-coherence-episode.test.ts` (NEW, 12) — episodeId + path shape, absent/ok/corrupt matrix (invalid-json, bad-version, missing-recurrence, episode-shape, recurrence-shape), between-episodes round-trip (episode:null + persisted recurrence), atomic write (subdir creation, no tmp leftover, last-writer-wins). 12 green; `tsc --noEmit` clean.

**Blast radius:** pure module + its test; NOTHING wires it in production yet (the state machine that reads/writes it is the next sub-unit). Fleet + single-machine unchanged.

### Increment C₁b-iii-b1 — episode STATE MACHINE core + §4.2 verbatim item render — LANDED

**What changed:**
1. **`src/monitoring/machineCoherenceEpisodeManager.ts` (NEW)** — `MachineCoherenceEpisodeManager`, the §4 state machine consuming the C₁b-iii-a durable layer + the confirmation engine's confirmed rows. `reconcile(input)` drives the lifecycle and returns EFFECTS the caller executes (the manager does no telegram I/O — only its own durable file + jsonl):
   - **Open** (§4.1) on the first confirmed row; **join** newly-confirmed rows into the OPEN episode with one append (never a 2nd item — the named anti-pattern).
   - **Suspend/resume** (§4.3): a skew participant leaving the VERIFIABLE set suspends (`peer-offline` when it drops offline, `peer-unverifiable` when online-but-not-compared) with an honest append; resume is silent (same item), then re-evaluates.
   - **Close taxonomy** (§4.3): `restored` (skew clear for `resolveTicks`; ONLY this claims restoration, note names the held ticks), `expired-peer-gone` (`expireIfStale`, suspended past `suspendedEpisodeExpiryMs`), `manifest-changed` (a flag key retired from the manifest intersection). Every close recorded in the recurrence memory (R2-N2, outlives close).
   - **§4.4 escalation**: one append past `escalateAfterMs` (unsuspended), suppressed by the durable operator **"leave it"** ack (`setOperatorAck`, R4-N2).
   - **Effect gating**: raise/append/resolve emit ONLY when `enabled && !dryRun && raiser === self` (`speaks()`); dry-run + non-raiser run the full machine + jsonl + `wouldRaise` counter, never speak.
   - **§4.6 corrupt re-baseline** on construction (the GuardPostureProbe pattern — bad file → fresh baseline + a `rebaseline` jsonl row, never a crash; drops any pendingFix R3-L3).
   - **§4.2 VERBATIM body render** (`renderBody`, pure): impact-first (manifest `guarantee` per row, by nickname), the approve-to-execute fix with the direction ALWAYS named (§4.2.1-ii — pool-majority else lease-holder), the two divergent-machine cases word-for-word (self+lease-holder → the named-failover clause; any-other-machine → "from my own hands there"), the "leave it" line, and the technical block last. Peer strings (nicknames, value classes) rendered as data.
   - `logs/machine-coherence.jsonl` transition-only, byte-cap safety rotation on append.
2. **Tests (green):** `tests/unit/machine-coherence-episode-manager.test.ts` (NEW, 16) — open + raiser/live/dry-run/non-raiser gating, join, suspend both reasons, resume→restored, restored-only-claims-restoration, escalation once + ack suppression, expired-peer-gone, corrupt re-baseline, both verbatim body branches. 16 green; `tsc --noEmit` clean.

**Blast radius:** NEW module + its test; NOT wired into the sentinel/server yet (the sentinel-tick wiring + refreshPool alarm-marker attach + the status route are the wiring slice). Fleet + single-machine unchanged.

**Documented partials (honest, not silent):**
- The precise **30-day time-based** jsonl prune (SessionWatchdog `rotateLog` shape) is deferred to the wiring slice as a periodic call on the sentinel cadence; this slice uses the byte-cap `maybeRotateJsonl` safety rotation (bounded growth — the real hazard) on append.
- `expireIfStale` uses `openedAtMs` as the suspended-since anchor (no explicit suspend-start timestamp in this slice); the precise suspend-start anchor + suspended-time accumulator land with the §4.5 recurrence slice (b2).
- §4.6 corrupt-path **adopt-or-resolve** of a locally-held stale item is handled minimally (fresh episode opens a new item id; a stale different-id item is left for operator ack — a bounded duplicate inside §0(b)'s envelope); the full adopt-or-resolve rides the wiring slice where the live attention store is in scope.

### Increment C₁b-iii-b2 — §4.5 recurrence damper + per-day cap + shared append budget — LANDED

**What changed:**
1. **`src/monitoring/machineCoherenceEpisode.ts`** — widened `RecurrenceBlock` with the damper's durable bookkeeping: `recentlyClosed[].itemId?` (so a reopen reuses the SAME item/topic), `appendBudget.reservedSuspendResumeAtMs?` (R4-L6 reserved slot), `capGiveupAtMs?` (once-per-24h give-up). All ride the same atomic file + §4.6 corrupt handling.
2. **`src/monitoring/machineCoherenceEpisodeManager.ts`** — the §4.5 brakes on the budget-exempt HIGH path (M2):
   - **Reopen damper**: a newly-confirmed skew whose N1 set intersects a `recentlyClosed` entry within `reopenWindowMs` RE-OPENS it — same item un-resolved + one "this divergence is back — re-opening" append, NO new item, and it does NOT count toward the per-day cap. `reopenCount` carried.
   - **Per-day cap**: at most `maxEpisodeItemsPerDay` NEW items per rolling 24h (`newItemTimestamps`); past the cap, further episodes are jsonl-only + counted, and ONE give-up note fires (once per window) — "coherence is flapping faster than I'll alarm … see /pool/machine-coherence" (P19 give-up-loudly).
   - **Shared per-episode append budget (R3-M5)**: ALL intra-episode FLAP-class appends (row-join, suspend/resume) share ONE rolling `episodeAppendBudget` per `episodeAppendWindowMs` — `pushFlapAppend` bounds them to `budget + 1` (the one "flapping — recording silently" note), then jsonl-only until the rolling count falls back below budget (latch exit, R4-N3/L7). ONE slot is RESERVED per window for the first suspend/resume (R4-L6 — the clock-changing note never crowded out). Structural appends (escalation, cap give-up) do NOT ride this budget.
   - **Latched-flapping reopen mode**: after `flappingLatchReopens` re-opens in the window → latched (one note, then jsonl-only); the window resets after `reopenWindowMs`.
   - Rolling-window eviction is LAZY (`pruneRecurrence`, R3-L2 — never triggers a write on its own).
3. **Tests (green):** `tests/unit/machine-coherence-episode-manager.test.ts` +4 (now 20) — per-day cap + once-loud give-up, reopen reuses the SAME item id (no new item, cap-exempt), the burst invariant (10 flap transitions → exactly `budget + 1` appends), the reserved suspend/resume slot surviving a spent budget. 20 green; `tsc --noEmit` clean.

**Blast radius:** additive to the (still-unwired) EpisodeManager + its durable shape; NOTHING constructs it in production yet. Fleet + single-machine unchanged.

**Documented partial:** the precise suspend-since anchor + suspended-time accumulator (§4.2.1-v executing-verifying clock pause) land with the pendingFix slice (b3), which introduces the executing-verifying state those clocks belong to; this slice's `expireIfStale` still uses `openedAtMs` as the suspend anchor (noted in b1).

### Increment C₁b-iii-b4 — sentinel wiring + effect execution + status route (the feature is ALIVE) — LANDED

**What changed:**
1. **`src/monitoring/MachineCoherenceSentinel.ts`** — the sentinel now OWNS the EpisodeManager when a `stateDir` dep is provided (absent in pure unit tests → classification-only, as before). New deps `stateDir?()` + `nicknameOf?()`. In `tick()`, after confirmation + election (and once past the N8 warm-up), it assembles the reconcile input (confirmedRows + compared/online sets + self/raiser/leaseHolder + nicknameOf) and calls `reconcile` + `expireIfStale`, queuing the returned effects. `drainPendingEffects()` returns + clears them (keeps the tick sync + Tier-0 — the caller executes the telegram I/O). `status()` now surfaces the real `openEpisode` + `episodeCounters`. `setOperatorAck` passthrough (for the b3 reply path).
2. **`src/monitoring/machineCoherenceEpisodeManager.ts`** — jsonl path corrected to the agent-root `logs/` dir (`stateDir/../logs`, matching the house convention) from the b1 `stateDir/logs`.
3. **`src/commands/server.ts`** — the C₁b-i sentinel construction now passes `stateDir: () => config.stateDir` + `nicknameOf` (from `machinePoolRegistry` capacities). After `tick()`, the `peerPresenceTick` drains the effects and executes them ASYNC + best-effort: `raise` → `telegram.createAttentionItem` (id `machine-coherence:<episodeId>`, HIGH, category `machine-coherence`), `append` → `telegram.getAttentionItem(id).topicId` + `sendToTopic`, `resolve` → topic note + `updateAttentionStatus(id,'DONE')`. A telegram fault never crashes the shared tick (fail toward silence). Module-level `_machineCoherenceSentinel` exposes it to the route; wired into the AgentServer ctx as `getMachineCoherence`.
4. **`src/server/AgentServer.ts` + `src/server/routes.ts`** — threaded `getMachineCoherence` through the options → routeCtx → RoutesContext, and registered **`GET /pool/machine-coherence`**: 503 when the guard is dark (getter null — dev-gated, never constructed on the fleet), else the §6 `status()` snapshot (enabled/dryRun/universe counts/classifications/raiser/openEpisode/counters + episodeCounters).
5. **Tests (green):** `tests/unit/MachineCoherenceSentinel.test.ts` +2 wiring-integrity (a stateDir-wired sentinel drives the EpisodeManager and `drainPendingEffects` returns a REAL raise + `openEpisode` populated; without a stateDir it's classification-only, empty drain) = 23. `tests/integration/machine-coherence-route.test.ts` (NEW, 2 — the "feature-alive" Tier-2: 503 dark, 200 with a live sentinel that opened an episode). 295 across the coherence + wiring + route sweep green; `tsc --noEmit` clean.

**Blast radius:** the guard is now CONSTRUCTED + TICKING + RAISING on a live-gate dev agent (dryRun defaults TRUE → runs the full machine + `wouldRaise` counters, raises NO item until a deliberate `dryRun:false`); the route serves its status. Fleet: `enabled` gate → false → never constructed → route 503s → unchanged. Single-machine: `tick()` strict no-op → no episode.

### Increment C₁b (remainder) + D₂b + E — PENDING
Remaining: (b3) §4.2.1 pendingFix reply-recognition flow (proposal → approved-holding → executing-verifying in the conversational path, single-flight, invalidation, executing-verifying suspend-pause clocks); the §3.2 alarm-MARKER attach into refreshPool's advert + §3.4 cross-machine takeover/fallback/reconciliation; the precise 30-day jsonl time-prune; the §6 boot-line already exists (C₁b-i) — extend it if desired. D₂b (awakeMachineCount counting rule + D5 shape sweep) and E (CLAUDE.md template mention of the route + "why did I get a machine-coherence alarm?" trigger via generateClaudeMd/migrateClaudeMd, Tier-3 e2e over real AgentServer, release fragment).
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
