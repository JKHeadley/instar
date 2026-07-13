---
title: "Quiet-Settings Follow the Agent — Replicated Operator-Settings Overlay"
slug: "quiet-settings-overlay"
author: "echo"
principal-deferral-approval: "v1 conversational-only confirmation for NON-suppression noise keys — argued exemption per Threat model (suppression-class keys carry the structural server-confirm gate); direction + auto-apply approved by operator 2026-07-12 (design-brief decision, topic 29836)"
---

# Quiet-Settings Follow the Agent — Replicated Operator-Settings Overlay

**Direction:** Approved by operator 2026-07-12 ("proceed with your recommendations" on the design brief): **Option A scoped tight** — a replicated operator-settings overlay limited to an allowlisted set of noise/narration keys, **auto-apply**, with the machine-coherence guard as the divergence safety net (Option B as net, Option C's push-on-set as delivery optimization).
**Parent principle:** Structure > Willpower; One Memory (WS2 replicated stores); "quiet decisions must follow the agent, not the machine."
**Ancestor incident:** 2026-07-11 — operator quieted alert noise; the quieting landed in ONE machine's config file; the Laptop rejoined the mesh two days later with the OLD settings and re-flooded the Attention hub.

## Terminology

- **Census** — `GET /operator-settings`: the read surface listing the allowlist catalog, overlay records, and per-machine application state.
- **Attention hub** — the single durable "🔔 Attention" Telegram topic where attention-queue items are delivered.
- **Calm episode flow** — the #1456 machine-coherence alerting behavior (episode-scoped, self-heal-first, honest escalation).
- **Dark peer** — a pool machine currently unreachable from the queried machine.
- **Guard-posture breadcrumb** — a row in `logs/guard-posture.jsonl` recording a posture change across boots.

## Problem statement

Operator intent expressed as per-machine config silently forks across machines. When the operator says "quiet these alerts," today that decision becomes an edit to `.instar/config.json` on whichever machine handled the conversation. Every other machine — especially one OFFLINE at decision time — keeps the old values and re-applies stale behavior when it rejoins. The 2026-07-11 re-flood is the defining case: a broadcast write could not have fixed it (the Laptop wasn't there to receive it); only a durable, replicated record that the rejoining machine reads on boot closes the class.

## Proposed design

### D1. A new replicated store kind: `operatorSettings`

Rides the WS2 replicated-store foundation exactly like preferences (WS2.1) and learnings (WS2.2):

- **Store key** `operatorSettings`, **record kind** `operator-setting-record`, registered via `replicatedKindRegistry.register(OPERATOR_SETTINGS_KIND_REGISTRATION)` in the server boot path AND listed in `CoherenceJournal.JOURNAL_KINDS` (dual-registry coupling; the existing CI wiring-integrity test extends automatically).
- **Record identity:** `recordKey` = the canonical config key path. One record per key (the overlay is the union of records). **Multi-key quieting is intentionally non-atomic** — each key is an independent record; a partially-landed group is visible per-key on the census. No batch semantics in v1. (A bundle/"desired profile" record shape was considered and rejected: it adds a second record kind with its own partial-application semantics, while per-key LWW + per-key census visibility already surfaces exactly which pieces landed. The conversational layer MUST warn when one operator intent maps to multiple independent writes — "this quiets 3 settings; they apply independently.")
- **Record fields (schema-clamped on receive, whole-record QUARANTINE on violation — never partial apply, never pass-with-flag):** `keyPath` (allowlist member — see D2), `value` (per-key clamp), `setAt` (ISO-8601-only), `setBy` (verified-operator provenance captured AT WRITE TIME — a historical audit fact, never a live authority claim; current authority is resolved live at each write/delete; Verify the State, Not Its Symbol), `sourceMachine`, `note` (≤ 280 chars, optional; stored verbatim; every rendering surface wraps it in the standard untrusted-data envelope; never interpolated into alert text or config).
- **Audit trail:** every ACCEPTED write is an append-only journal envelope — LWW keeps one *live* record per key, but the journal history retains the full write stream (who/when/what, including churn). The census row additionally carries `writeCount24h` per key so burst-churn is visible at a glance, and the write funnel enforces a **per-key accepted-write cap of 6 per 24h** (excess ⇒ 429 naming the cap) — churn cannot hide inside LWW coalescing.
- **Tombstones:** deleting an overlay key returns that key to the machine-local file value everywhere, including on machines offline at delete time. Tombstone retention rides the foundation's §6.5 deleted-keys high-water guard (adopted explicitly), so an aged-out tombstone cannot let a lagging peer resurrect the key.
- **Conflict tier: LOW-impact** (HLC latest-writer wins, overwrite FLAGGED, never silent). A config value needs exactly one winner; the HIGH-tier append-both answer is meaningless here. Foundation-verified: `UnionReader` implements LOW-tier max-HLC-wins + `divergenceFlag` (UnionReader.ts ~L280–291); the flag flows to `/state/conflicts` AND is projected onto the census row (`overwriteFlagged: true`). Clock-skew abuse is bounded by the foundation's §3.4 bounded-drift quarantine; residual risk within the drift window is accepted (see Threat model) because the value space is noise-knobs.
- **Bounds:** retention 256 KiB (steady state ≤ 17 records, ~30× headroom for churn history), rate-cap 20 capacity / 5 refill-per-sec on the local route (429 + retry-after; nothing queues silently). **The rate-cap governs LOCAL writes only** — replicated receives bypass it (they were rate-bounded at their origin; dropping receives would lose data).
- **Ships dark:** `multiMachine.stateSync.operatorSettings: { enabled: false, dryRun: true }` — standard WS2 ladder, dev machines first. Single-machine agents: replication inert; the local funnel, census, boot merge, and notices all still work.

### D2. The allowlist (code-defined, never config-defined)

A single exported constant `OPERATOR_SETTINGS_ALLOWLIST: Record<keyPath, { type, clamp, consumer, suppressionClass }>` in the store module. **Every path into the store — the POST route, the receive-side applier, and any internal caller — passes through ONE shared validation funnel (`validateOperatorSettingWrite`)**; there is no second entry point (covers the single-machine case where no receive applier exists). Initial membership (17 keys):

| keyPath | type/clamp | consumer | suppression-class |
|---|---|---|---|
| `monitoring.machineCoherence.dryRun` | boolean | MachineCoherenceSentinel | yes (true suppresses) |
| `monitoring.machineCoherence.calmEnabled` | boolean | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.calmRaiseNotify` | boolean | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.silentResolveNote` | boolean | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.patchSkewPriority` | enum `NORMAL`\|`HIGH` | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.calmWaveThreshold` | number 1–24 | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.skewFlapThreshold` | number 1–10 | MachineCoherenceSentinel (#1456) | no |
| `monitoring.burnDetection.enabled` | boolean | BurnDetector | yes (false suppresses) |
| `monitoring.burnDetection.absoluteShareThreshold` | number 0.05–1 | BurnDetector | no |
| `monitoring.ropeHealth.enabled` | boolean | RopeHealthMonitor | yes (false suppresses) |
| `monitoring.ropeHealth.urgentEnabled` | boolean | RopeHealthMonitor | no |
| `monitoring.sentinelTelegramEscalation` | boolean | sentinel escalation router | no |
| `monitoring.activeWorkSilenceSentinel.enabled` | boolean | ActiveWorkSilenceSentinel | no |
| `monitoring.activeWorkSilenceSentinel.silenceThresholdMs` | number 5m–4h | ActiveWorkSilenceSentinel | no |
| `promiseBeacon.suppressUnchangedHeartbeats` | boolean | PromiseBeacon | no |
| `promiseBeacon.beaconLivenessIntervalMs` | number 10m–6h | PromiseBeacon | no |
| `monitoring.reapNotify.enabled` | boolean | reap notifier | no |

**Suppression-class keys** (3) are the ones whose write can turn OFF a detector that watches the agent/system itself. Two structural protections apply to a write that flips such a key to its suppressing value:

1. **Server-driven operator confirm (the structural gate — Structure > Willpower):** the POST does NOT commit. It returns `202 { pendingId, expiresAt }`, and the SERVER itself sends the confirmation prompt to the topic's VERIFIED operator over the existing authenticated message surface. The precise mechanics (all deterministic):
   - **One open pending per topic:** a suppressing POST while another pending is open on that topic ⇒ `409` naming the open pendingId. No pending pile-up, no prompt ambiguity.
   - **Prompt format:** "Quiet-settings change needs your confirm: turn OFF burn-detection alerts on ALL machines? Reply `yes <pendingId>` to confirm or `no <pendingId>` to decline (or just reply yes/no to this message)."
   - **Reply matching (closed grammar, no interpretation):** a commit requires an authenticated inbound message from the operator that is EITHER a Telegram reply-to the server's own prompt message containing the bare case-insensitive token `yes`/`no`, OR a message containing `yes <pendingId>`/`no <pendingId>`. Anything else matches nothing (first unmatched attempt gets one format reminder; then silence; expiry is the conservative default). Ambiguous natural language is deliberately NOT interpreted — a non-matching reply can never commit.
   - **Principal re-verified at reply time:** the pending captures the verified operator principal at POST; the commit requires the replying sender to be authenticated, to MATCH the captured principal, AND to still be the topic's currently-bound verified operator. An operator-binding change between POST and reply VOIDS the pending (visible as `voided: operator-changed`).
   - **Expiry 15 minutes.** Pendings persist in the local store (survive restart); expiry is evaluated on the watcher tick and swept at boot. On expiry or decline: nothing commits, and ONE outcome line is sent to the initiating topic ("that quiet-settings change wasn't confirmed in time — nothing was changed; re-request if still wanted"), so a not-landed change is never silent. Expired/declined/voided pendings remain census-visible with their status for 24h, then age out. Re-request is allowed immediately (subject to the rate/churn caps).
   - **No HTTP confirm path exists:** there is NO route, Bearer or otherwise, that submits a confirmation — confirmation flows ONLY through the authenticated inbound-message match above. The agent cannot self-confirm by construction, and adding a confirm route is a spec violation, not an implementation choice.

   The UNSUPPRESSING direction (turning a detector back ON) and tombstone-deletes are single-step: restoring detection never needs friction.
2. **Non-recallable notice:** at commit time, one calm notice line is DELIVERED to the Attention hub ("burn-detection alerts were turned off via quiet-settings by <operator> — Nth change to this key today — census link"). Delivery is the hub's Telegram send at raise time; a later agent-side attention resolution cannot recall a delivered message. Dedupe: one notice per (keyPath, suppressing-value, setBy) per 24h rolling window, persisted in store metadata (survives restarts); the census `writeCount24h` keeps repeat churn visible even when the notice dedupes. Detector display names derive from the keyPath's second segment, kebab-cased (`burnDetection` → "burn-detection").

Non-suppression keys are single-step writes; their human confirmation lives in the conversational contract (see Threat model for the argued v1 exemption, formalized in the frontmatter `principal-deferral-approval`).

**Effective-suppression bounds (clamps justified against detection purpose):** every numeric clamp maximum is chosen so the detector still FUNCTIONS at the extreme — `silenceThresholdMs` max 4h still fires within a workday; `beaconLivenessIntervalMs` max 6h still produces a liveness line per session stretch; `calmWaveThreshold` max 24 (tightened from 100) keeps the wave backstop live at worst one-alarm-per-hour-of-churn; `skewFlapThreshold` max 10 (tightened from 50) keeps flap detection meaningful. A knob whose maximum would render its detector effectively OFF belongs in the suppression class instead — that is the membership test for future numeric keys. (`sentinelTelegramEscalation` is opt-in-default-false, so writing `false` restores the default rather than suppressing an active protection.)

Deliberately **rejected** from the allowlist (each rejection + reason is queryable via the census so the agent can explain a refusal conversationally; the CLAUDE.md template carries the trigger + a pointer, not the full list):

- `monitoring.burnDetection.alertTopicId`, `monitoring.ropeHealth.digestTopicId` — topic-id routing values are authority-bearing (they decide WHERE alerts go, and are not validated against target-topic authority). Deferred until target-authority validation exists.
- `meshTransport.recoveryProbeEnabled` — transport-structural, not noise.
- `developmentAgent` — structural root trait; stays per-machine, surfaced by the coherence guard.
- All `multiMachine.*` / `stateSync.*` — the overlay must not gate its own transport.
- `scheduler.enabled`, `routingSpend.*`, `secrets.*`, `monitoring.permissionPromptAutoResolver.*` — structural / money / secrets / safety-floor.
- `operatorSettings.autoRestartToApply` — machine-local operational lever; overlay-setting it is a bootstrap circularity.

Membership rule for future additions: a key qualifies only if its worst-case misuse changes *what the operator hears*, never *what the agent may do*; any routing/targeting semantics (topic ids, URLs, paths) is categorically out until target-authority validation exists.

### D3. The overlay-resolution seam (precedence rule)

**The config file is never rewritten by the overlay.** The overlay is a separate durable layer merged at ONE seam:

- **Local persistence:** `.instar/state/operator-settings.json` (atomic tmp+rename) holding records + tombstones + store metadata (`generation`, `lastEffectiveHash`, notice-dedupe state, pending confirms). Applies are serialized through the store's single applier funnel (the journal applier already batches; a burst of receives lands as one batched file write). The file is ≤ 256 KiB, so write cost is negligible; no cross-process contention exists (one server process owns it).
- New pure function `resolveEffectiveConfig(baseConfig, overlayRecords)` → effective config + per-key source map (`file` | `overlay`). Precedence: **overlay > file, for allowlisted keys only**; every other key passes through untouched. Total, side-effect-free.
- **Boot-seam ordering invariant (no replay race):** boot reads the LOCAL durable store file ONLY — never waits on journal replay or the network. Records arriving after the boot read follow the running-machine path (D4). A rejoining machine boots on values as-of-its-last-sync and converges via the pending path — deterministic, race-free.
- Called at server boot, after config load and before guard construction — every boot-read guard sees effective values with zero per-guard changes. (**Why restart-to-apply rather than hot-reload:** guards resolve config once at construction by architecture; adding live-read seams to every consumer is a far larger, riskier change touching each guard. Server restarts are already routine — the auto-updater performs them constantly — and tmux sessions are unaffected by a server restart. Hot-reload per-consumer is a possible later optimization, deliberately out of v1.)
- `guardPosture.resolveGuardConfigSnapshot()` applies the same overlay merge, so `GET /guards` reports the guard's REAL effective posture with a per-row `source: overlay` marker; the guard-posture tripwire attributes overlay-driven changes to the overlay in the breadcrumb.
- **Boot drift canary (self-vs-self):** each boot computes the canonical effective-hash (D6) and compares against the previous boot's `lastEffectiveHash`. A change with NO new overlay records and NO config-file change = a resolution bug ⇒ one loud log line + a guard-posture breadcrumb. **Update semantics:** the anomaly is recorded FIRST, then `lastEffectiveHash` is updated to the current hash — so each boot reports at most once (bounded by boot frequency) and a persisting bug re-reports on each subsequent boot rather than becoming silently canonical. The canary changes no values (signal-only; the resolved config stands — conservative default is the deterministic resolution, with the anomaly loud).
- **Returning control to the file** = tombstone the overlay key. **Honest consequence, surfaced:** deletion restores each machine's OWN file value, which may differ across machines. The DELETE response (and conversational confirmation) previews the resulting per-machine values **for the deleted key only** — these are clamped noise-knob types by construction (boolean/enum/bounded number), so no other config content and no secret-bearing value can appear. Machines without fresh census data are listed honestly: "unknown — machine offline (its own file value will apply when it rejoins)"; the preview never blocks on dark peers.

### D4. Auto-apply (the approved behavior)

1. **Rejoining/booting machine (the incident class):** overlay read from the local store at boot, before guard construction — covered passively.
2. **Already-running machine receiving a change:** the record is persisted to the local store IMMEDIATELY (no "received but lost before boot" window); guards are boot-read, so the process marks `pending-restart` and schedules a restart under the governance bounds.

**Application state machine (per machine):**
- Record lands whose effective value differs from the running process's constructed value ⇒ census state `pending-restart` (level-based: store `generation` ≠ the `appliedGeneration` stamped at this boot).
- `applied` = this boot stamped `appliedGeneration >= record generation` (stamped once, immediately after `resolveEffectiveConfig`).
- A failed/killed restart leaves the marker (level-based; re-evaluated on the restart-watcher's existing poll cadence, ~10s, and at every boot).
- `pending-restart` persisting past `pendingStaleCeilingMs` (default 24h) raises ONE calm attention line, deduped on stable-id `operator-settings-pending:<machineId>:<generation>` — a new generation opens a new window; the same stuck generation never re-raises.

**Restart governance:**
- **Coalescing:** restart need is ONE level-based marker (the generation gap) — K writes collapse to one pending restart by construction. (Churn forensics are preserved independently: journal history + `writeCount24h` + the per-key 24h write cap — coalescing hides restarts, never evidence.)
- **Dwell:** ≥ 15 min between overlay-driven restarts per machine. **Daily cap:** 4 per machine per 24h; past it, the marker persists visibly until the ceiling line surfaces it. Worst-case disruption from a hostile writer: 4 clean-window restarts/day, all audited.
- **Clean window:** the existing drift-promoter predicate (no in-flight forwards, no queued messages, no traffic in the last 90s), checked at scheduling AND re-verified at fire; dirty-at-fire ⇒ marker stays, watcher re-evaluates.
- Lever: `operatorSettings.autoRestartToApply` (machine-local config, default **true**; `false` ⇒ apply only at natural restarts). The POST response and the conversational confirmation state plainly: "this will restart the agent server on affected machines at a quiet moment."
- **No self-reinforcing loop:** nothing in boot, applier, or restart paths writes overlay records — writes originate only from the authenticated route funnel. Restart → boot → read is read-only.

### D5. Write path and census (conversational-first)

**Write authority model (explicit):** `topicId` is REQUIRED on POST and DELETE. The principal resolves through the existing `TopicOperatorStore` surface: each topic carries at most ONE verified operator, bound automatically from the authenticated sender of an authorized message (never from content names). No binding on the named topic ⇒ 400. A Bearer caller naming an arbitrary topicId gains nothing beyond attribution to THAT topic's verified operator — which for suppression-class keys routes the confirm prompt to that very operator (who did not ask, and declines), and for non-suppression keys is exactly the accepted-residual case in the Threat model. A stale binding is the operator's existing topic-operator surface to correct; replayed topicIds change nothing (each write re-resolves the CURRENT binding live).

- `POST /operator-settings` (Bearer) `{ keyPath, value, note?, topicId }`, e.g. `{ "keyPath": "monitoring.burnDetection.enabled", "value": false, "topicId": 29836 }`: shared funnel (allowlist + clamp + per-key 24h cap), `setBy` resolved from the topic's VERIFIED bound operator (`TopicOperatorStore`) — 400 when no verified principal resolves; suppression-class suppressing writes ⇒ the 202 server-confirm flow (D2); everything else commits: persist + journal emit (the push-on-set). 429 on rate/churn caps.
- `DELETE /operator-settings/:keyPath` body `{ topicId }` — same funnel + principal rule recorded on the tombstone; response carries the per-machine preview (D3). Always single-step (returning to file values / restoring detection needs no friction).
- `GET /operator-settings` → census: the allowlist catalog (key, type, clamp, plain-English description, suppression-class marker, rejected-keys with reasons), every record (value, setBy, setAt, sourceMachine, `overwriteFlagged`, `writeCount24h`), pending confirms, and THIS machine's application state + generation. `?scope=pool` merges per-machine application state (pool-heartbeat "online" definition; dark peers = explicit `failed` rows; rides the shared pool-cache).
- All routes 503 when the store is dark on this agent.
- **Conversational surface (deterministic intent mapping):** the agent maps "quiet X" via the census catalog (never free-form key guessing), then proposes the exact keyPath + clamped value + a before/after diff + the restart note, and confirms before writing. A request matching a REJECTED key is answered with its recorded reason. (For suppression-class keys the binding confirmation is the server's own prompt — the conversational confirm is UX, the server confirm is the gate.)

### D6. The safety net (Option B as net)

Two generations exist per machine, named precisely (they differ exactly while a restart is pending):

- **`durableGeneration`** — max HLC across the local store file's records + tombstones (quarantined records NEVER count). Advances at persist time; monotone by construction (a max only grows; out-of-order application cannot regress it; equal-HLC applications leave it unchanged — the hash comparison covers content).
- **`runningAppliedGeneration`** — the durableGeneration stamped at THIS process's boot, immediately after `resolveEffectiveConfig`. `pending-restart` ≡ `runningAppliedGeneration < durableGeneration` (the D4 level marker, restated).

Each machine's advert gains three fields (built as part of this spec): `durableGeneration`, `runningEffectiveHash` (the canonical hash over the RUNNING process's resolved effective values), and `overlayPending` (the boolean above).

- **Canonical hash:** `v1:` + sha256 of `sortedAllowlistedKeyPaths.map(k => `${k}=${JSON.stringify(effectiveValue)}`).join('\n')` over post-clamp resolved values; absent keys omitted; enum casing as stored. Canonicalization is normative — hash mismatch must mean value mismatch. **Scope honesty:** D6 detects BEHAVIORAL divergence only (same value from file vs forced by overlay hashes identically); provenance divergence is the census's job (per-key source map).

Divergence classification (grace-gated by the existing confirm-ticks discipline, riding the #1456 calm episode flow — no new watcher, no new escalation authority):
- **Peer advert LACKS the overlay fields** (older version): excluded from overlay comparison entirely — never a skew episode against a not-yet-updated machine.
- **durableGeneration lag** (peer behind the pool max): sync-lag, expected during catch-up; skew row only past the existing staleness ceiling.
- **durableGenerations equal, runningEffectiveHash differs, peer `overlayPending` within its governance window:** apply-lag, silent (like version-skew grace).
- **durableGenerations equal, runningEffectiveHash differs, NOT pending (or past window):** real overlay bug ⇒ skew row in the existing episode flow.

Because a running machine persists received records immediately (D4), "behind and unaware" cannot exist: every machine is sync-lagged (visible via durableGeneration), apply-lagged (visible via overlayPending), or genuinely diverged (episode).

## Threat model (honest residuals)

- **Peers are the agent's own mesh-authenticated machines.** A fully compromised peer is largely outside this store's threat model (it can already do worse than tweak noise knobs); defense-in-depth still applies: bounded-drift quarantine caps HLC abuse, schema quarantine rejects malformed records, the allowlist caps the value space, suppression-class writes carry the server-confirm gate + non-recallable notice.
- **A misbehaving agent session cannot silently suppress detectors:** the suppression class requires the server-matched operator confirm (no Bearer path to commit), and the commit notice is delivered (not recallable). What a misbehaving session CAN do without fresh confirmation is write NON-suppression noise keys (thresholds, intervals, calm levers). Residual harm: bounded to loudness/quietness within clamps, durably attributed, census-visible, tombstone-reversible, restart-capped, churn-capped (6/key/24h). **This is the argued v1 exemption** (formalized in frontmatter): for these keys the API-layer human-confirm would add friction disproportionate to the harm class, and the operator explicitly approved auto-apply for exactly this class.
- **Bearer-token theft** ⇒ the thief can write non-suppression noise knobs (attributed, visible, capped) and can READ the census catalog. The catalog grants no capability beyond what Bearer access already grants everywhere else; hiding the suppression-class column would be obscurity, not structure (declined — the structural controls are the confirm gate + non-recallable notice).

## Decision points touched

| Decision point | Classification | Notes |
|---|---|---|
| Allowlist membership + clamps + per-key 24h cap (single shared funnel, all entry paths) | **invariant** | Deterministic set membership, typed clamps, counter cap; violation ⇒ refusal/quarantine. |
| Suppression-class confirm gate | **invariant** | Pure table lookup (class membership + suppressing-direction) decides the 202 path; commit requires the server-matched authenticated operator reply under the CLOSED reply grammar (FD 17 — token match, never interpretation; a non-matching reply cannot commit); principal re-verified at reply; no HTTP confirm path exists. Conservative default: expire uncommitted, with the outcome line (FD 18). |
| Conflict resolution (LOW tier, HLC latest-writer + flag) | **invariant** | Deterministic HLC ordering (foundation-verified); flag projected to census + /state/conflicts. |
| Write/delete principal check | **invariant** | Structural refusal on unresolvable principal; `setBy` historical, never live authority. |
| Restart governance (coalesce, dwell 15m, cap 4/day, 90s clean window, 24h ceiling) | **invariant** | Named constants; conservative default = defer; level-marker persists; visibility guaranteed. |
| Suppression/pending notice emission + dedupe | **invariant** | Deterministic keys: (keyPath, suppressing-value, setBy)/24h and `operator-settings-pending:<machineId>:<generation>`. Delivery at raise time is non-recallable. |
| Corrupt-store fallback at boot | **invariant** | Per-record schema skip; unparseable file ⇒ quarantine-aside + file values + loud log. Conservative default = the machine's own config file. |
| Census pool-merge dark-peer handling | **invariant** | Dark peer ⇒ explicit `failed` row; DELETE preview lists offline machines as honest "unknown". |
| Overlay-vs-pool divergence flagging (D6) | **judgment-candidate (inherited)** | Rides the machine-coherence guard's existing episode flow and floor: bounded action space (raise/hold/resolve, signal-only), conservative default (calm), deterministic dedupe + escalation ceiling (#1456). This spec adds comparison INPUTS, not a new arbiter. |

## Multi-machine posture

- **Overlay records** — `unified`: replicated via the WS2 journal, tombstoned deletes, LOW-tier conflict surfacing. The store is the feature.
- **Per-machine application state** (`applied`/`pending-restart` + generation, pending confirms) — `proxied-on-read` via `GET /operator-settings?scope=pool` (dark-peer-tolerant, explicit failed rows). Derived, self-healing at each boot; replicating it would add staleness, not truth.
- **The base config file** — machine-local BY DESIGN, pre-existing and unchanged by this spec; `machine-local-justification: physical-credential-locality` (it carries ports/paths/per-machine service bindings and secret refs that physically belong to one disk; the overlay exists precisely so operator noise-intent stops living there). Machine-local operational levers (`operatorSettings.autoRestartToApply`, governance constants) are keys INSIDE this already-declared file — not independent state surfaces. Drift in these levers is not invisible for lack of a posture marker: each machine's census row and `GET /guards` report the lever's LIVE per-machine value, so a machine whose auto-apply is off (or whose governance was tuned) is a read, not a guess.
- **User-facing notices** — the suppression-class notice + pending-stale line ride the EXISTING attention hub with the deterministic dedupe keys above, raised by the machine that commits/holds the state (no pool-wide double-raise). **Standard-B scope note:** these are signal-only disclosures of a deliberate operator decision and a visibility ceiling on a level state — not first-detection escalations of a recoverable degradation, so no self-heal step applies (there is nothing to heal; the "degradation" is the operator's own choice / a visible pending state). D6 rides the existing one-raiser-elected episode flow.
- **Generated URLs** — none introduced.

## Frontloaded Decisions

1. **Conflict tier = LOW** (latest-writer + flag) — a config value needs exactly one winner. Foundation-verified.
2. **Initial allowlist = the 17 keys in D2**, rejections recorded (incl. both topic-id keys), suppression-class column shipped as store metadata AND census-visible.
3. **`autoRestartToApply` default = true**, machine-local config, NOT overlay-settable.
4. **Overlay never rewrites config.json** — separate layer, single merge seam, source-tagged /guards.
5. **Tombstone = return-to-file**, with per-machine preview (deleted key only, clamped types, dark peers honestly "unknown"). No per-machine exemption mechanism.
6. **Write authority = Bearer + verified topic-bound operator provenance** on POST and DELETE; suppression-class suppressing writes additionally require the server-matched operator confirm (202 flow, 15-min expiry, no Bearer confirm endpoint).
7. **Local store = `.instar/state/operator-settings.json`** (atomic writes; records, tombstones, generation, lastEffectiveHash, notice-dedupe state, pending confirms). Boot reads ONLY this file.
8. **`overlayGeneration` = max HLC over APPLIED records + tombstones** (quarantined never counts); advert carries `(overlayGeneration, overlayEffectiveHash)`; v1 canonical hash as defined in D6; behavioral-divergence-only scope stated.
9. **Restart governance constants:** 90s clean-window re-verified at fire; 15-min dwell; 4/day cap; 24h pending-stale ceiling; ~10s watcher poll. Defaults as module constants; per-machine overrides under machine-local `operatorSettings.governance.*` config keys.
10. **Application state machine** per D4 (generation-stamped at boot; level-based marker; no timeouts, visibility ceilings instead).
11. **Corrupt-store handling:** per-record schema skip; unparseable file ⇒ quarantine-aside + file values + loud log + breadcrumb. Canary update semantics: record anomaly first, then update lastEffectiveHash (re-reports per boot while the bug persists).
12. **Dashboard surface (read or write) explicitly OUT of this spec** — follow-on increment tracked under Close the Loop at build time. Not tagged cheap (published operator interface; its own decision when built).
13. **Single-machine behavior** — local overlay fully functional; replication inert.
14. **Suppression-class membership = the 3 marked keys**; notice text pattern fixed (detector name = keyPath second segment kebab-cased; carries operator, Nth-change-today, census link); dedupe keys as in the Decision-points table.
15. **Churn bounds:** per-key accepted-write cap 6/24h at the funnel; `writeCount24h` on census; journal history is the audit stream.
16. **Non-atomic multi-key groups** — deliberate (bundle record shape rejected — see D1); the conversational layer warns when one intent maps to multiple writes.
17. **Confirm-reply grammar (closed, deterministic):** reply-to-prompt bare `yes`/`no`, or `yes <pendingId>`/`no <pendingId>`; case-insensitive token match; anything else matches nothing (one format reminder, then expiry). One open pending per topic (409 otherwise). Principal captured at POST, re-verified at reply; binding change voids the pending.
18. **Post-expiry visibility:** expiry/decline/void sends ONE outcome line to the initiating topic; the pending stays census-visible with status for 24h; immediate re-request allowed (subject to caps).

## Open questions

*(none — all decisions frontloaded above)*

## Failure honesty

- Journal/store sync dark or wedged → machines keep file values (or last-synced overlay); census shows generation lag; nothing blocks.
- Partition double-write → latest-writer wins, overwrite flagged on census + `/state/conflicts`; one calm surfacing.
- Malformed/hostile replicated record → whole-record quarantine, counted, quarantine-visible; quarantined records never count toward generation.
- Restart window never clean / cap reached → level marker persists, census + /guards show pending, 24h ceiling line surfaces it (deduped per machine+generation).
- Pending suppression-confirm expires (operator silent 15 min), is declined, or is voided by an operator-binding change → nothing commits; ONE outcome line to the initiating topic; the pending stays census-visible with its status for 24h. A not-landed change is never silent.
- Overlay store file corrupt at boot → quarantine-aside + boot on file values + loud log; /guards shows `source: file` everywhere.
- Older-version peer receives `operator-setting-record` → silently ignored (foundation unknown-kind forward-compat); its advert lacks overlay fields ⇒ excluded from D6 comparison; no errors, no false alerts; picks the store up on update.
- Feature disabled after use → foundation un-merge semantics: replicated contributions drop (quarantined-aside, reversible); machines revert to file values at next boot; pending markers cancel; local records quarantined-aside, never destructively deleted.

## What this does NOT do

- No general config sync, no fleet-management plane — allowlisted noise knobs only.
- PATCH /config semantics untouched.
- Cannot disable safety floors, its own transport, structural flags, or redirect alert routing — by allowlist construction.
- No new watcher, no new escalation authority; the two notice lines ride the existing attention hub with deterministic dedupe.

## Testing (four tiers)

- **Unit:** shared-funnel validation (member/non-member/clamps/per-key cap, every entry path), `resolveEffectiveConfig` precedence + source map + pass-through, receive-clamps + quarantine, tombstone semantics + high-water guard, LOW-tier flag projection, canonical-hash stability, generation monotonicity under out-of-order + equal-HLC + quarantined records, restart-governance bounds, state-machine transitions, notice dedupe keys (incl. across-restart persistence), boot drift canary (incl. update-after-record semantics), suppression-confirm flow (202, one-open-pending 409, closed reply grammar incl. non-matching replies, principal re-verify at reply, binding-change void, expiry sweep at boot, outcome line, no-HTTP-confirm), **concurrent writes ⇒ one stable effective value across repeated boots**.
- **Integration:** POST/DELETE/GET routes (auth, principal-refusal, clamp-refusal, 429 rate + churn caps, 503-when-dark), suppression-class 202 + server prompt + commit-on-reply, census catalog + rejected-keys + `overwriteFlagged` + `writeCount24h` + pending confirms, /guards source marker + pending posture, notice emission + dedupe, DELETE preview (clamped-types-only, dark-peer "unknown"), `?scope=pool` merge with explicit failed row.
- **E2E:** boot with overlay record ⇒ guard constructed with overlay value (the rejoin case — the single most important test); running-server change ⇒ immediate persist ⇒ pending ⇒ clean-window restart ⇒ applied + generation stamped; partitioned concurrent writes then heal (flag + one winner); set→delete→set across a partition; suppression write end-to-end (202 ⇒ operator confirm ⇒ commit ⇒ hub notice delivered); wiring-integrity (dual registries, seams non-null).
- **Test-as-Self / live proof (Live-User-Channel Proof standard):** an operator-role session drives the REAL conversational surface end-to-end — "quiet the machine-drift alarms everywhere" ⇒ agent proposes exact key + diff + restart note from the census catalog ⇒ confirm ⇒ write ⇒ **verification artifact: `GET /guards` on the affected machine shows the key's effective value with `source: overlay`, and the census shows `applied` at the new generation.** Then the **live-pair ancestor-incident replay before fleet:** set a quiet-knob on machine A with machine B offline; boot B; verify on B via the same artifacts (guards source:overlay + census applied) that B came up quiet.

## Migration & awareness

- **No data migration:** the overlay starts empty; file values remain authoritative until the operator sets a key.
- Config defaults via `migrateConfig()` (existence-checked): the `multiMachine.stateSync.operatorSettings` dark block + the machine-local `operatorSettings` block.
- **Agent briefing via BOTH paths (Migration Parity), framework-agnostic:** `generateClaudeMd()` gains the "Quiet-Settings Overlay" section (census route, the proactive trigger — an operator noise/quieting decision goes through the overlay whenever the key is allowlisted, never a bare per-machine config edit — the show-diff-before-write + restart-note rule, and a pointer to the census for the rejected-keys reasons); AND `migrateClaudeMd()` gains a content-sniffing migration (guard: section-header absence, e.g. no `## Quiet-Settings Overlay` marker ⇒ append) so EXISTING agents receive it on update, not only new inits. The section rides the existing **framework-shadow propagation** in `PostUpdateMigrator` (CLAUDE.md sections mirrored into `AGENTS.md` / `GEMINI.md` where those exist, ~L8384–8619), so Codex/Gemini-hosted agents get equivalent awareness — no framework is privileged. **Build checklist item:** the new section's marker must be ADDED to the shadow-propagation marker list in the same PR that adds the section (the list is enumerated; a missing marker means shadows never receive it). The full rejected-keys list lives in the census (Registry First), keeping the always-loaded briefing tight.
- Forward-compat during rollout: old-version peers ignore the new kind and are excluded from D6 comparison (restated in Failure honesty).
