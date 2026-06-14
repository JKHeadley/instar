---
title: "Guard-Posture Endpoint — read every machine's safety-guard flags from anywhere"
slug: "guard-posture-endpoint"
author: "echo"
eli16-overview: "GUARD-POSTURE-ENDPOINT-SPEC.eli16.md"
status: "approved"
approved: true
approved-by: "Justin (uid:7812716706), Telegram topic 13481"
approved-at: "2026-06-12T07:18:23Z"
layer: "core-instar-primitive"
parent-principle: "Observable Intelligence — No Autonomous LLM Action Is Unauditable (here applied to guard posture: no safety posture is allowed to be invisible; a disabled guard you cannot see is how the Mac Mini's reaper stayed off for a week)"
project: "multimachine-coherence"
origin: "GAP-001 (2026-06-11, topic 13481): the Mini's SessionReaper was disabled by the June load-shed and stayed off unnoticed — the June 8 recovery swept the laptop only, because no API exposes a machine's guard posture; the workaround (spawning throwaway sessions to cat config) died twice to update restarts"
supervision: "tier0 — deterministic read-only aggregation of config + runtime state; no LLM decision"
review-convergence: "2026-06-12T05:07:59.923Z"
review-iterations: 5
review-completed-at: "2026-06-12T05:07:59.923Z"
review-report: "docs/specs/reports/guard-posture-endpoint-convergence.md"
---

# Guard-Posture Endpoint — read every machine's safety-guard flags from anywhere

## 1. Problem

A machine's safety-guard posture (which guards are actually on) is invisible over the API. `PATCH /config` can WRITE config remotely, but there is no read; `/features` covers feature toggles, not monitoring guards; the Guard-Posture Tripwire fires only on enabled→disabled TRANSITIONS at boot and logs to local disk — a machine that never reboots never even gets its one alarm, and steady-state-off is invisible forever. Consequence, lived 2026-06-11: the Mac Mini's SessionReaper had been disabled since the June incident load-shed and stayed off for a week — the post-incident re-enable swept the laptop because nobody could SEE the Mini's posture without SSH (unreachable cross-network) or spawning a throwaway session to `cat` the config (fragile: update restarts killed the readout twice). A guard that cannot be observed is a guard that silently stays off.

**Why not `/health` or `/features`?** `/health` is the liveness surface (is the server up, degradations) and is partially unauthenticated by design — guard posture is operationally sensitive (see §6) and must never ride it. `/features` is the operator-facing feature-toggle registry with enable/disable actions — guard posture is read-only and spans components `/features` deliberately doesn't model. A dedicated read surface keeps both contracts clean.

## 2. Design

### 2.1 The single guard inventory — reuse the tripwire's extractor over RESOLVED config

**One definition of "what is a guard," shared by code.** `GuardPostureTripwire.extractGuardPosture()` already extracts the posture (object-with-`enabled` keys AND plain-boolean `monitoring.*` keys AND `scheduler.enabled` AND `models.tierEscalation.{enabled,dryRun}`). That function is lifted into a shared module (`src/monitoring/guardPosture.ts`) consumed by BOTH the tripwire and this endpoint — never re-derived (the SafeGitExecutor single-funnel lesson). A Tier-1 test pins: endpoint inventory ⊇ tripwire inventory for the same config.

**Resolved config, not raw key presence.** The inventory runs over the MERGED effective config (ConfigDefaults + on-disk file + dev-gate resolution via `resolveDevAgentGate` for DEV_GATED_FEATURES whose convention is to OMIT `enabled`). A guard absent from the agent's config file still appears with its default-resolved state; a dev-gated guard appears with its gate-resolved value. Tier-1 tests cover both.

**Guards the config cannot see — the declared manifest + runtime registry.** Some real guards have no config key at all (default-ON-in-code: the Topic-Flood Guard, topicCreationBudget — living in `src/messaging/`, not `src/monitoring/`) or live outside `monitoring.*` (`lifeline.driftPromoter`, `multiMachine.secretSync`). The authoritative discovery boundary is a STATIC DECLARED MANIFEST (`src/monitoring/guardManifest.ts`): one entry per guard the codebase ships, each declaring `{ key, kind, configPath | codeDefault, expectedTickMs?, liveConfig?: boolean, subGuards?: [...], process: 'server' | 'lifeline' }`. At boot, constructed guard components self-register their runtime getters into a `GuardRegistry`, which is RECONCILED against the manifest: a manifest guard that should be constructed on this host but registered no runtime reports `effective: "missing"` (counted in `summary.missing`, amber) — expected-but-absent is a STATE, never a silent omission (monitoring components are routinely constructed conditionally; a crash-before-register or an unconfigured host adapter must not erase the guard from view). Sub-guards (e.g. `contextWedgeSentinel.autoRecovery`, `correctionLearning.selfViolationSignal`) are their own manifest entries and inventory rows — a component registers one row PER declared sub-guard, so "autoRecovery silently off inside an on-confirmed sentinel" cannot hide. Out-of-process guards (`process: 'lifeline'`, e.g. `lifeline.driftPromoter`) are an explicit class: config-derived states only (`on-unverified` at best, boot-snapshot divergence applies), never runtime-enriched — the sync in-memory getter contract cannot cross processes and the spec says so rather than letting the implementer improvise. Manifest entries with `liveConfig: true` mark components that re-read config per use; the `diverged-pending-restart` state is SUPPRESSED for them (the change is already live — without this flag the state lies in the false-positive direction after every PATCH). The endpoint's inventory = shared extractor (config-derived) ∪ manifest (declared), deduped by key; for manifest guards with a `configPath` outside the extractor's domain, the manifest's resolver derives `configEnabled`/divergence from the same one-snapshot disk read; for `codeDefault` guards, divergence is N/A and stated as such in the row (`divergence: "not-applicable"`) — an honest scope line, not an overclaim. **CI ratchet (manifest-driven, repo-wide):** a lint requires every component matching the guard shape (constructed at boot with an enabled-style switch or a tick loop, in ANY of `src/monitoring`, `src/messaging`, `src/lifeline`, `src/core`) to appear in the manifest or in `NOT_A_GUARD` classifications with a reason — path-pattern linting scoped to one directory would miss this spec's own canonical examples. **The introduction PR ships the complete backfill**: every existing boot-constructed component classified (guard-with-manifest-entry or NOT_A_GUARD) so the lint lands green per the Zero-Failure Standard — this sweep is the largest implementation line-item and is budgeted as such. The lint follows the `lint-dev-agent-dark-gate.js` + exclusions-list precedent with its own unit test; it is repo-CI-side only, so Migration Parity is explicitly N/A.

### 2.2 `GET /guards` (Bearer-auth, read-only) — honest effective states

```json
{
  "machineId": "m_…", "nickname": "Mac Mini", "version": "1.3.487", "generatedAt": "…",
  "guards": [
    { "key": "monitoring.sessionReaper", "configEnabled": true, "defaultEnabled": true,
      "runtime": { "enabled": true, "dryRun": false, "lastTickAt": 1781235505463, "tickAgeMs": 41000, "stale": false },
      "effective": "on-confirmed", "offClass": null },
    { "key": "monitoring.watchdog", "configEnabled": true, "defaultEnabled": true,
      "runtime": null, "runtimeReason": "not-instrumented", "effective": "on-unverified", "offClass": null },
    { "key": "monitoring.failureLearning", "configEnabled": false, "defaultEnabled": false,
      "runtime": null, "runtimeReason": "not-instrumented", "effective": "off", "offClass": "dark-default" }
  ],
  "summary": { "onConfirmed": 4, "onUnverified": 8, "onStale": 0, "onDryRun": 1, "off": 14,
               "offDeviant": 1, "offDarkDefault": 13, "divergedPendingRestart": 0, "errored": 0, "missing": 0, "offRuntimeDivergent": 0,
               "runtimeEnriched": "5/27" }
}
```

**Effective-state vocabulary (the honesty layer — every state distinct, none folded):**
- `on-confirmed` — config on AND a live runtime surface confirms it, NOT stale, NOT dry-run.
- `on-unverified` — config on, no runtime surface (`runtimeReason: "not-instrumented"`). NEVER counted or rendered as confirmed-on (grey, not green): a guard that crashed mid-init lands here, and painting it green is the Mini bug with extra steps.
- `on-stale` — runtime exists but its liveness signal is dead: `lastTickAt` of 0/absent while enabled, or `tickAgeMs` > N× the guard's self-declared expected cadence (each registry entry declares `expectedTickMs`; N=5). Constructed-but-never-ticking reports HERE, never "on". Tier-1 test pins `enabled:true, lastTickAt:0 → on-stale`.
- `on-dry-run` — enabled with `runtime.dryRun: true` — watching but toothless; counted and rendered separately (amber).
- `off` — with `offClass`: `"dark-default"` (configEnabled === defaultEnabled === false — ships-dark features; rendered quiet/collapsed) vs `"diverged-from-default"` (default on, currently off — the load-shed signature; amber, named on the dashboard card). This classification is what keeps amber meaningful: without it every healthy machine shows ~14 offs forever and the one deviant drowns (alarm-fatigue is how the next Mini stays off while displayed).
- `diverged-pending-restart` — the on-DISK resolved value differs from the BOOT-time posture snapshot the tripwire already persists (`state/guard-posture.json`). Derivable for EVERY guard, including `runtime: null` ones — this, not runtime comparison, is the primary divergence mechanism (a PATCH or direct disk edit before restart). Components on the liveConfig pattern legitimately never show it (documented). If the boot snapshot is absent or was written by an older inventory (missing keys), divergence for the affected guards is SUPPRESSED AND FLAGGED (`divergence: "snapshot-unavailable"`) — degraded honestly, never silently clean. A runtime self-reporting `enabled: false` against an on-config still derives `off-runtime-divergent` in this degraded mode (the runtime contradiction does not depend on the snapshot).
- `errored` — the runtime status getter THREW (`runtimeReason: "status-error"` + a normalized message). A caught exception gets LOUDER, not quieter: counted in `summary.errored`, amber.
- `missing` — declared in the manifest for this host, but no runtime registered at boot (crash-before-register, unconfigured host adapter). Amber; never silently absent.
- `off-runtime-divergent` — resolved config says ON (and disk matches the boot snapshot) but a live runtime surface self-reports `enabled: false` — the IN-MEMORY load-shed class (a component paused/self-disabled without any config change). Amber, counted in `summary.offRuntimeDivergent`; the strongest possible "the config is lying to you" signal and it must never fold into `on-unverified`. Tier-1 pin: `configEnabled:true, runtime.enabled:false, no disk divergence → off-runtime-divergent`.

**Normative precedence (one state per guard; first match wins):** route-level config-read failure (whole-response `error`) → `errored` → `missing` → `off-runtime-divergent` (runtime contradicts an on-config AND disk matches the boot snapshot; snapshot-unavailable counts as no detected divergence — otherwise the disk divergence states below apply) → `diverged-pending-restart` (suppressed for `liveConfig` guards) → `off` (with `offClass`) → `on-dry-run` → `on-stale` → `on-confirmed` (runtime confirms) → `on-unverified` (no runtime surface). Implementers get a decision table, not a vocabulary to re-derive; a Tier-1 test pins each transition edge (e.g. dry-run + stale → `on-dry-run` reports, with `stale: true` still visible in the runtime block).

**`configEnabled` source, pinned:** ONE on-disk config read per request (a snapshot — never per-guard reads), resolved per §2.1. Disk, not `ctx.config`, because the original incident was an emergency DIRECT DISK EDIT invisible to the in-memory config until restart. Tier-1 test pins one-read-per-request.

**Runtime enrichment contract:** getters MUST be synchronous in-memory property reads (the `lastTickAt`/`jobCount` shape) — no async, no file/process/tmux I/O in the enrichment path; the <100ms criterion depends on this and a Tier-1 test enforces it (handler completes without awaiting any component). Per-guard try/catch isolates failures (→ `errored`). The scheduler's runtime carries `enabled`, `lastTickAt`, `jobCount`, `pausedJobCount` (registration is not life; a wedged tick loop or load-shed pause must not read healthy).

**Strict output projection (the no-secrets guarantee, enforced not promised):** the route emits ONLY the closed field set shown above. It NEVER spreads or serializes source config/runtime objects — several guard config objects carry operationally sensitive values (`burnDetection.alertTopicId` is a Telegram routing target; `collaborationRedrive` carries trust floors). Getters are untrusted producers; the route is the projection authority. Tier-1 leak tests: `alertTopicId` never appears in any response; a generic assertion that no response field falls outside the allowlist.

**Self-honesty floor:** `summary.runtimeEnriched: "n/total"`. The Tier-3 E2E pins a floor — sessionReaper, scheduler MUST report non-null runtime on a healthy production-init server (wiring-integrity per the Testing Integrity Standard). If a refactor silently unwires enrichment, the E2E fails rather than every guard quietly degrading to `on-unverified`.

**Config-read failure** produces a top-level `error` field (5xx) — never a truthful-looking empty `guards: []`.

### 2.3 Fleet visibility — heartbeat piggyback FIRST, pool fan-out for deep reads

**Primary path (zero new fan-out): posture summary rides the capacity heartbeat.** Each machine's existing capacity heartbeat (the `quotaState` precedent) gains a compact `guardPosture` block: `{ onConfirmed, onUnverified, onStale, onDryRun, offDeviant, offDeviantKeys: [...], offRuntimeDivergent, offRuntimeDivergentKeys: [...], divergedPendingRestart, errored, missing, generatedAt }` (a few hundred bytes, bounded by the manifest size). Ingestion rules, pinned: (a) the block is BOUND to the authenticated sender identity at receipt — a body-claimed `machineId` is data and can never overwrite another machine's posture row (the same merge-identity rule as the fan-out, stated for this channel explicitly, because a poisoned heartbeat painting the Mini green is the cheapest attack on this design); (b) displayed age derives from RECEIVER-side receipt time (the `MachinePoolRegistry` `routerReceivedAt` rule — freshness NEVER keys on a peer's self-reported clock; `generatedAt` is data), so replay/clock-skew cannot fake freshness; a clock-quarantined peer's posture still renders (quarantine is placement-only) with its quarantine flagged. (c) **Durability:** the in-memory pool registry is rebuilt from heartbeats, so last-known posture would evaporate on a local server restart — defeating dark-peer honesty in exactly the GAP-001 topology (a week-dark Mini + the laptop's routine update restarts). The compact posture block is therefore ALSO persisted in the durable machine record alongside `lastHeartbeatAt` (additive field, older peers ignore it), reloaded at boot, and rendered with its REAL age ("as of 2d ago"). The Machines tab renders from `GET /pool` as it already does — no new polling, no join problem; a machine with no posture ever received renders "guards: unknown", never "0 on / 0 off".

**Deep read: `GET /guards?scope=pool`** (on-demand sweeps, agent queries). Mirrors the `sessions?scope=pool` contract — parallel fan-out, 5s/peer timeout, per-peer failure rows, never a 500 — with these spec-level additions over the inherited shape:
- **Every registered (non-revoked) machine is accounted for**: a machine with no `lastKnownUrl`, or filtered as inactive, emits an explicit `failed: [{machineId, reason: "no-known-url" | "offline"}]` row — NEVER silently omitted (silent omission re-creates the blind spot at the pool level; this differs from the sessions fan-out and is deliberate). Response carries `knownMachines` vs `peersQueried` counts.
- **Classified failures**: `reason: "timeout" | "unreachable" | "unauthorized" | "route-missing" | "no-known-url" | "offline" | "url-rejected" | "error"` — normalized enum, never raw `err.message` (error strings leak URL/TLS internals). A peer 404 (pre-`/guards` version) classifies as `route-missing` with the peer's known version; the dashboard renders "needs update to report", not a phantom outage, during rollout skew.
- **No recursion**: the fan-out fetches plain `GET /guards`, never `?scope=pool` (explicit, not inherited by analogy).
- **Merge identity**: rows are keyed on the REGISTRY's machine identity; a response body's self-reported `machineId` is data, and a mismatch is flagged, never allowed to shadow another machine's row.
- **Single-machine/dark-mesh degradation**: no resolvable peers → self's guards with `pool: { enabled: false, peersQueried: 0 }` (the sessions contract), never an error.
- **Latency criteria**: <100ms applies to LOCAL `GET /guards` only; pool reads are bounded by the 5s/peer parallel timeout with partial results.

**Pull-vs-push, acknowledged:** the deep read is pull-based for consistency with existing internal APIs and zero new infrastructure; the heartbeat piggyback IS the push half — together they cover both live sweeps and dark-peer honesty.

### 2.4 The structural consumer — posture that gets READ without willpower

A readable surface nobody reads is a wish (Structure > Willpower; the tripwire's steady-state gap stays open if this ships as dashboard-only). The same project ships a `GuardPostureProbe` in the existing SystemReviewer probe family: on the established probe cadence it evaluates the pool posture and raises **ONE deduped-per-episode** Attention item when a `diverged-from-default` off, an `off-runtime-divergent`, an `on-stale`, a `missing`, or an `errored` guard persists across consecutive probes — aggregated (one item listing all anomalies; P17 Bounded Notification Surface), episode-keyed (P19), quiet for `dark-default` offs. **Data source rule:** heartbeat posture (with its age) is the input for every peer; the deep-read fallback fires ONLY for peers the registry currently believes ONLINE whose heartbeat block is missing or stale — for offline/dark peers the probe evaluates the durable last-known posture + age directly, NEVER a doomed fan-out (a permanently-dark peer must not buy a 5s timeout on every probe tick forever). **Episode semantics, pinned:** an episode ends only when the underlying condition CLEARS; acknowledging mutes the open episode (no re-alarm while it persists); a cleared-then-recurring anomaly is a NEW episode. **Flap awareness:** the probe records per-guard posture deltas between its own ticks; a guard flipping more than K times within the probe window raises a `flapping` anomaly even if each individual sighting looks settled — sub-cadence toggling (disk edits between probes) must not be invisible to all three layers. For heartbeat-sourced (especially dark) peers, anomalies other than the two key-carrying classes are count-only in the Attention item — deliberate: the compact block carries per-key detail only for the two sharpest signals (§3(f)).

### 2.5 The companion write path — named, de-scoped, tracked

The first real use of this read surface is "the Mini's reaper is off — turn it back on remotely." Today's only remote lever is `PATCH /config`, whose ONE-LEVEL-DEEP merge wholesale-replaces nested objects — re-enabling `sessionReaper.enabled` via a partial patch silently DESTROYS its tuning (lived 2026-06-11: the remediation had to hand-reconstruct the full block). Convergence round 2 established that a safe flip lever is NOT a narrow addition: for `scheduler`, `models`, `lifeline`, and `multiMachine` roots (all in this inventory) no remote write path exists today, so a lever would be an authority EXPANSION; the inventory's heterogeneous shapes (plain booleans, registry-only keys, `dryRun` keys where enable/disable verbs invert safety — `models.tierEscalation` is a one-call remote cost-doubler) each need their own write semantics; and a third config-write path needs a single write funnel plus effect-timing honesty. That is a spec of its own. **Remote flipping is therefore OUT OF SCOPE here and tracked as the REMOTE-GUARD-FLIP follow-up spec <!-- tracked: GAP-001-remote-guard-flip -->**, which must resolve: per-shape write semantics with read-back-through-the-shaped-getter verification, a `GUARD_FLIPPABLE_KEYS` allowlist with the enableaction-validity test pattern, effect-timing (`applied-live` vs `pending-restart` from the registry's `liveConfig` flag), serialization with `PATCH /config` through one write funnel, flip-time (not next-boot) cost-increase Attention emits, and per-flip audit rows.

**Interim hazard containment (ships in THIS project):** the CLAUDE.md template's guard section gains an explicit warning — "to re-enable a guard via `PATCH /config`, send the guard's FULL config block (the merge is one-level-deep and a partial block erases sibling tuning); read the current block from `GET /guards`' source machine first" — so the next remediation doesn't fire the loaded gun unaware. This warning rides the same `migrateClaudeMd()` migration §4 mandates for the Guards block.

### 2.6 What this is NOT

- NOT an enforcement surface: nothing auto-re-enables; the probe (§2.4) raises an attention item, a human or an agent decides (signal, not authority).
- NOT a config reader: the closed projection only — never arbitrary config values.
- NOT a replacement for the tripwire: transitions-at-boot (tripwire) + steady-state-readable (this) + cadenced anomaly probe (§2.4) are three complementary layers sharing ONE inventory definition.
- NOT a future notification firehose: any future alerting consumer MUST aggregate to one item per episode through the budgeted funnel (pre-committed here; the §2.4 probe is the reference implementation).

## 3. Security model (post-auth information disclosure, stated)

Guard posture is an attack-timing oracle by nature ("the reaper is off → my implant session survives") — that sensitivity is inherent to the feature's value. Containment: (a) `GET /guards` sits behind the standard Bearer middleware — never added to any auth exemption list; Tier-2 test pins the 401. (b) Posture data is FORBIDDEN on unauthenticated or signed-URL surfaces (`/health`, `/ping`, public views); the dashboard surface is PIN-gated. (c) The pool fan-out forwards the machine's OWN Bearer token to peer URLs sourced from the registry's `lastKnownUrl` — that value is self-advertised and git-synced, so the fan-out's trust assumption is "the registry remote is operator-private." This is a pre-existing property of every `scope=pool` route, inherited NOT silently: this spec makes the hardening a SHIPPING DEPENDENCY, not a recommendation: `GET /guards?scope=pool` attaches the token only to peer URLs passing an https + allowlisted-host-pattern check (known tunnel domains + RFC-1918/localhost for LAN peers), implemented as a shared helper so existing pool routes can adopt it <!-- tracked: topic-13481-fanout-hardening -->; a peer whose `lastKnownUrl` fails the check contributes `failed: [{machineId, reason: "url-rejected"}]` — visible, never silently skipped, never sent the token. The endpoint's sensitivity is exactly why this route does not ship on the unhardened fan-out. (d) `scope=pool` is non-recursive and modestly rate-limited (the existing spawnLimiter pattern) — one inbound request must not amplify into a peer-spray loop. (e) `version`/`nickname` disclosure is intentional (operator benefit) and post-auth-only. (f) The heartbeat `guardPosture` block replicates the sharpest signal (`offDeviantKeys`) peer-to-peer and stores it at rest on every machine: this is an ACCEPTED, CONTAINED exposure — the heartbeat transport carries the same machine-level authentication as the Bearer surface, recipients are exclusively the operator's own paired machines, and the at-rest copy lives in the same state directory as the config it summarizes; what is FORBIDDEN is re-exporting it onto any weaker surface (containment (b) applies to replicas identically). (g) Posture is self-attested telemetry: a compromised machine can lie about its own posture (report all-confirmed). Inherent to all telemetry; the cross-check is the deep read disagreeing with the heartbeat, which the probe flags.

## 4. CI / repo-standard compliance (named, so the implementer can't trip them)

- **CAPABILITY_INDEX**: `/guards` registers as a full capability entry (agents reach for it conversationally) — required by the capabilities-discoverability test for any new top-level prefix.
- **Dark-gate lint**: deliberately NO `enabled` key in ConfigDefaults — an off-switch on the guard-visibility surface would itself be an invisible disabled guard. The lint is satisfied by having no gate at all; precedent class: reap-log, TokenLedger (always-on read-only observability). Do not "fix" this by adding `guards.enabled`.
- **E2E-pairing**: the Tier-3 route-aliveness e2e is staged in the SAME commit as the routes change; the EXEMPT marker is forbidden for this feature.
- **Agent Awareness Standard**: `generateClaudeMd()` gains a Guards capability block (curl examples + proactive triggers: "are my guards on?" / "why didn't the watchdog fire on machine X?" / post-incident sweep → `GET /guards?scope=pool`), cross-referenced from the tripwire section, WITH the corresponding `migrateClaudeMd()` content-sniffed migration in the same PR (Migration Parity).

## 5. Failure honesty

Per-peer failures → classified rows, never 500. Per-guard getter failures → `errored`, louder not quieter. Config-read failure → top-level error, never empty-truthful. Unreachable/unregistered-URL machines → named rows. Mixed-version peers → `route-missing`, not phantom outage. Empty mesh → self-only with `pool.enabled: false`.

## 6. Testing (Testing Integrity Standard — all three tiers)

- Tier 1: shared-extractor parity (endpoint ⊇ tripwire); resolved-config inventory (absent-key default-on guard appears; dev-gated omitted-`enabled` guard appears gate-resolved); registry union + dedupe; effective-state derivation for every vocabulary state incl. `enabled:true,lastTickAt:0 → on-stale` and dry-run; offClass against defaults; one-config-read-per-request; sync-getter enforcement; projection allowlist + `alertTopicId` leak test; failure-reason normalization. (Lever tests live in the REMOTE-GUARD-FLIP follow-up spec <!-- tracked: GAP-001-remote-guard-flip --> — out of scope here.)
- Tier 2: route integration — 200 with Bearer, 401 without; scope=pool with mocked peers: success, classified timeout, 404→`route-missing`, no-known-url row, identity-mismatch flag; single-machine degradation.
- Tier 3: "feature is alive" E2E on the production init path — `GET /guards` 200 with non-empty inventory AND the runtime-enrichment floor (sessionReaper + scheduler non-null), staged same-commit with the route.

## 7. Rollback

Route + probe + dashboard line: revert and ship a patch. The CLAUDE.md template section requires a removal migration if rolled back (Migration Parity cuts both ways — stated, not hidden). The heartbeat `guardPosture` block is additive and ignored by older peers. No data migration.

## 8. Acceptance criteria

1. LOCAL `GET /guards` lists the full shared-extractor + registry inventory with truthful, verification-level-labeled states in <100ms (sync in-memory reads only).
2. `GET /guards?scope=pool` from the laptop accounts for EVERY registered machine — the Mini's posture row, or a named classified failure row; never a silent omission. The Machines tab shows last-known posture (with age) even for a currently-dark peer, via the heartbeat piggyback.
3. A guard flipped on disk (PATCH or direct edit) without restart reports `diverged-pending-restart` — for all config-backed, non-`liveConfig` guards, runtime-enriched or not (boot-snapshot comparison; `codeDefault` rows are `divergence: "not-applicable"` per §2.1).
4. `enabled:true` with a dead tick loop reports `on-stale`, never `on` (the Mini's `lastTickAt: 0` era is the pinned regression).
5. A `diverged-from-default` off OR an `off-runtime-divergent` persisting across probe ticks raises exactly ONE aggregated Attention item per episode — the in-memory disable class is covered by the no-willpower layer, not just manual reads.
6. A manifest guard whose component failed to register at boot reports `missing` — never silently absent from the inventory (the reconciliation pin).
7. A peer's posture age on the Machines tab derives from receiver-side receipt time and survives a local server restart (durable last-known posture, rendered "as of <age> ago").
8. A peer `lastKnownUrl` failing the https/allowlist check is never sent the Bearer token and appears as a named `url-rejected` failure row.
