---
title: "Quiet-Settings Follow the Agent — Replicated Operator-Settings Overlay"
slug: "quiet-settings-overlay"
author: "echo"
---

# Quiet-Settings Follow the Agent — Replicated Operator-Settings Overlay

**Direction:** Approved by operator 2026-07-12 ("proceed with your recommendations" on the design brief): **Option A scoped tight** — a replicated operator-settings overlay limited to an allowlisted set of noise/narration keys, **auto-apply**, with the machine-coherence guard as the divergence safety net (Option B as net, Option C's push-on-set as delivery optimization).
**Parent principle:** Structure > Willpower; One Memory (WS2 replicated stores); "quiet decisions must follow the agent, not the machine."
**Ancestor incident:** 2026-07-11 — operator quieted alert noise; the quieting landed in ONE machine's config file; the Laptop rejoined the mesh two days later with the OLD settings and re-flooded the Attention hub.

## Problem statement

Operator intent expressed as per-machine config silently forks across machines. When the operator says "quiet these alerts," today that decision becomes an edit to `.instar/config.json` on whichever machine handled the conversation. Every other machine — especially one OFFLINE at decision time — keeps the old values and re-applies stale behavior when it rejoins. The 2026-07-11 re-flood is the defining case: a broadcast write could not have fixed it (the Laptop wasn't there to receive it); only a durable, replicated record that the rejoining machine reads on boot closes the class.

## Proposed design

### D1. A new replicated store kind: `operatorSettings`

Rides the WS2 replicated-store foundation exactly like preferences (WS2.1) and learnings (WS2.2):

- **Store key** `operatorSettings`, **record kind** `operator-setting-record`, registered via `replicatedKindRegistry.register(OPERATOR_SETTINGS_KIND_REGISTRATION)` in the server boot path AND listed in `CoherenceJournal.JOURNAL_KINDS` (the dual-registry coupling; the existing CI wiring-integrity test extends automatically).
- **Record identity:** `recordKey` = the canonical config key path (e.g. `monitoring.machineCoherence.dryRun`). One record per key — the whole overlay is the union of records. The key path IS the cross-machine identity.
- **Record fields (schema-clamped on receive, whole-record QUARANTINE on violation — never partial apply, never pass-with-flag):**
  - `keyPath` (string; MUST be a member of the code-defined allowlist — see D2; a non-allowlisted keyPath fails the schema `validate()` ⇒ the record is quarantined per the foundation's §5 semantics, counted, never applied)
  - `value` (type-clamped per-key: boolean / enum / bounded number — the allowlist entry carries the clamp)
  - `setAt` (ISO-8601-only)
  - `setBy` (verified-operator provenance captured AT WRITE TIME: platform + authenticated uid — a content-name can never appear here by construction; Know Your Principal). **`setBy` is a historical audit fact — "who was the verified operator when this was written" — never a live authority claim.** Current authority is always resolved live at the next write/delete; a later operator change does not invalidate the record, and the census renders `setBy` as historical attribution (Verify the State, Not Its Symbol).
  - `sourceMachine` (machine id)
  - `note` (length-bounded free text ≤ 280 chars, optional; stored verbatim; every rendering surface — census JSON consumed by an agent, dashboard, any message — wraps it in the standard untrusted-data envelope; it is never interpolated into alert text or config)
- **Tombstones:** deleting an overlay key (op `delete`) returns that key to the machine-local file value everywhere, including on machines offline at delete time. Tombstone retention rides the foundation's §6.5 deleted-keys high-water guard (adopted explicitly here, not by implication), so an aged-out tombstone cannot let a lagging peer resurrect the key.
- **Conflict tier: LOW-impact** (HLC latest-writer wins, overwrite FLAGGED via the existing conflict surfacing, never silent). Rationale: a noise knob must resolve to ONE effective value; "append both variants as advisory hints" (the HIGH-tier answer) is meaningless for a config value a guard must read as one concrete setting. Verified against the foundation: `UnionReader` implements LOW-tier max-HLC-wins + `divergenceFlag` (UnionReader.ts ~L280–291); the flag flows to `/state/conflicts` and is ALSO projected onto the census row (`overwriteFlagged: true`) so the overwrite is visible where the operator actually looks. Clock-skew abuse is bounded by the foundation's §3.4 bounded-drift quarantine (a future-stamped record past `maxDriftMs` is quarantined); residual risk within the drift window is accepted for this store because the value space is noise-knobs (see Threat model).
- **Bounds:** retention budget 256 KiB, rate-cap 20 capacity / 5 refill-per-sec. Sizing rationale: the store's steady state is ≤ the allowlist size (17 keys ⇒ well under 8 KiB of records); 256 KiB is ~30× headroom for tombstone/churn history. A rate-capped write returns 429 with the retry-after; nothing queues silently.
- **Ships dark:** `multiMachine.stateSync.operatorSettings: { enabled: false, dryRun: true }` — the standard WS2 graduated ladder, dev machines first. Single-machine agents: replication is inert; the local write path, local overlay application, and census all still work.

### D2. The allowlist (code-defined, never config-defined)

A single exported constant `OPERATOR_SETTINGS_ALLOWLIST: Record<keyPath, { type, clamp, consumer, suppressionClass }>` in the store module. **Every path into the store — the POST route, the receive-side applier, and any internal caller — passes through ONE shared validation funnel (`validateOperatorSettingWrite`)**; there is no second entry point (this covers the single-machine case where no receive applier exists). Initial membership (17 keys, each naming its consuming guard):

| keyPath | type/clamp | consumer | suppression-class |
|---|---|---|---|
| `monitoring.machineCoherence.dryRun` | boolean | MachineCoherenceSentinel | yes (true suppresses) |
| `monitoring.machineCoherence.calmEnabled` | boolean | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.calmRaiseNotify` | boolean | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.silentResolveNote` | boolean | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.patchSkewPriority` | enum `NORMAL`\|`HIGH` | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.calmWaveThreshold` | number 1–100 | MachineCoherenceSentinel (#1456) | no |
| `monitoring.machineCoherence.skewFlapThreshold` | number 1–50 | MachineCoherenceSentinel (#1456) | no |
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

**Suppression-class keys** are the ones whose write can turn OFF a detector that watches the agent/system itself (`burnDetection.enabled=false`, `ropeHealth.enabled=false`, `machineCoherence.dryRun=true`). A suppression-class write is still allowed (it IS a legitimate quiet decision) but emits **one calm, non-dismissable-by-the-agent notice line** to the Attention hub at apply time on the raising machine ("burn-detection alerts were turned off via quiet-settings by <operator> — census link"), so an agent quieting the alarms about its own misbehavior is always visible to the operator. This is signal-only and fires once per write, not per machine.

Deliberately **rejected** from the allowlist (recorded so the decision is visible, and each rejection + its reason ships in the CLAUDE.md template so the agent can EXPLAIN a refusal conversationally):

- `monitoring.burnDetection.alertTopicId`, `monitoring.ropeHealth.digestTopicId` — **topic-id routing values are authority-bearing** (they decide WHERE alerts go; a redirected topic is an information-flow change, and topic ids are per-forum, not verified against target-topic authority). Deferred to a later increment that validates target-topic existence + operator authority over the target. (Round-1 security finding.)
- `meshTransport.recoveryProbeEnabled` — transport-structural, not noise.
- `developmentAgent` — structural root trait; stays a deliberate per-machine decision surfaced by the coherence guard.
- All `multiMachine.*` / `stateSync.*` — the overlay must not gate its own transport.
- `scheduler.enabled`, `routingSpend.*`, `secrets.*`, `monitoring.permissionPromptAutoResolver.*` — structural / money / secrets / safety-floor.
- `operatorSettings.autoRestartToApply` — machine-local operational config (the "how do changes land HERE" lever); overlay-setting it would be a bootstrap circularity (an overlay write deciding whether overlay writes apply). Changed only via the local config file / PATCH.

Membership rule for future additions: a key qualifies only if its worst-case misuse changes *what the operator hears*, never *what the agent may do* — and any key that carries routing/targeting semantics (topic ids, URLs, paths) is categorically out until it has target-authority validation.

### D3. The overlay-resolution seam (precedence rule)

**The config file is never rewritten by the overlay.** The overlay is a separate durable layer merged at ONE seam:

- **Local persistence:** the local canonical store is `.instar/state/operator-settings.json` (atomic tmp+rename writes, like other state files) holding records + tombstones + store metadata (`generation`, `lastEffectiveHash`). The journal is the replication transport; this file is what boot reads.
- New pure function `resolveEffectiveConfig(baseConfig, overlayRecords)` → effective config + per-key source map (`file` | `overlay`). Precedence: **overlay > file, for allowlisted keys only**; every other key passes through untouched. Total, side-effect-free, unit-testable.
- **Boot-seam ordering invariant (no replay race):** boot reads the LOCAL durable store file ONLY — it never waits on journal replay or the network. Records that arrive via sync AFTER the store file was read follow the running-machine path (D4: persist immediately + `pending-restart`). A rejoining machine therefore boots on values as-of-its-last-sync and converges via the normal pending path — honest, deterministic, and free of boot/replay races.
- Called at server boot, after config load and before guard construction — so every boot-read guard (the majority; verified: guards resolve config once at construction, e.g. `resolveMachineCoherenceConfig`) sees effective values with zero per-guard changes.
- `guardPosture.resolveGuardConfigSnapshot()` (which deliberately re-reads disk each boot) applies the same overlay merge, so `GET /guards` reports the guard's REAL effective posture with a per-row `source: overlay` marker. The guard-posture tripwire attributes an overlay-driven change to the overlay (named in the breadcrumb), not a mystery config edit.
- **Boot drift canary (self-vs-self):** each boot computes the canonical effective-hash (D6) and compares it against `lastEffectiveHash` persisted from the previous boot. A hash change with NO new overlay records and NO config-file change since the last boot = a resolution bug ⇒ one loud log line + a guard-posture breadcrumb (never silent). (Lessons: state-detection needs a canary, not just determinism.)
- **Returning control to the file** = tombstone the overlay key. **Honest consequence, surfaced:** deletion restores each machine's OWN file value, which may DIFFER across machines — the DELETE response (and the conversational confirmation) includes a preview of the resulting per-machine effective values from the last-known pool census, so the operator sees any divergence they are about to re-create. No per-machine "exempt" escape hatch exists.

### D4. Auto-apply (the approved behavior)

Two cases:

1. **Rejoining/booting machine (the incident class):** the overlay is read from the local store at boot before guard construction — covered with no extra machinery, purely passive.
2. **Already-running machine receiving an overlay change:** the record is persisted to the local store IMMEDIATELY (so a crash/restart at any moment applies it — there is no "received but unapplied on next boot" window); guards are boot-read, so the running process marks `pending-restart` and schedules a restart under the **restart governance bounds** below.

**Application state machine (per machine, per store-generation):**
- A record lands whose effective value differs from the running process's constructed value ⇒ census state `pending-restart` (a level-based marker: the store generation ≠ the generation stamped at this boot).
- `applied` = the process's boot stamped `appliedGeneration >= record generation` (stamped once, immediately after `resolveEffectiveConfig` at boot).
- A failed/killed restart leaves the marker in place (level-based ⇒ re-evaluated next tick; no timeout, no edge loss).
- `pending-restart` persisting past `pendingStaleCeilingMs` (default 24h) raises ONE calm attention line via the existing hub (deduped per machine+generation) — pending can never rot silently.

**Restart governance (bounds proven against worst-case churn):**
- **Coalescing:** overlay-driven restart need is ONE level-based marker (the generation gap), not a queue — K writes in a burst collapse to one pending restart by construction.
- **Dwell:** minimum `restartMinIntervalMs` (default 15 min) between overlay-driven restarts per machine.
- **Daily cap:** max `restartDailyCap` (default 4) overlay-driven restarts per machine per 24h; past the cap the marker persists visibly and the pending-stale line (above) eventually surfaces it. The cap means a hostile/confused writer can force at most 4 restarts/day on a machine — and every one is clean-window-gated (never under live work) and audited.
- **Clean window (concrete):** the existing drift-promoter predicate — no in-flight forwards, no queued messages, no traffic in the last 90s — checked when scheduling AND re-verified at fire time; if dirty at fire, the level marker simply stays and the watcher re-evaluates.
- Lever: `operatorSettings.autoRestartToApply` (machine-local config; default **true** — the operator approved auto-apply; the store itself still ships dark first). `false` ⇒ pending states apply only at natural restarts.

**No self-reinforcing loop by construction:** nothing in the boot path, the applier, or the restart path WRITES overlay records — writes originate only from the authenticated route funnel. Restart → boot → read is a strictly read-only cycle.

### D5. Write path and census (conversational-first)

- `POST /operator-settings` (Bearer) body `{ keyPath, value, note?, topicId }`, e.g. `{ "keyPath": "monitoring.burnDetection.enabled", "value": false, "topicId": 29836 }`: runs the shared funnel (allowlist + clamp), resolves `setBy` from the topic's VERIFIED bound operator (`TopicOperatorStore`) — refused 400 when no verified principal resolves; persists locally, emits to the journal (the push-on-set). 429 on rate-cap.
- `DELETE /operator-settings/:keyPath` body `{ topicId }` — same funnel, same verified-principal resolution recorded on the tombstone (`setBy` of the delete), plus the per-machine effective-value preview in the response (D3).
- `GET /operator-settings` → the census: the allowlist itself (so the conversational layer has the enumerated catalog — key, type, clamp, plain-English description, rejected-keys list with reasons), every overlay record (value, setBy, setAt, sourceMachine, `overwriteFlagged`), and THIS machine's application state (`applied` | `pending-restart` + generation). `?scope=pool` merges each machine's application state; a machine is "online" per the existing pool heartbeat definition; dark peers appear as explicit `failed` rows (never silently omitted), riding the shared pool-cache like other pool-scope reads.
- All routes 503 when the store is dark on this agent.
- **Conversational surface (deterministic intent mapping, not free-form key guessing):** the agent maps "quiet X" via the census's enumerated catalog, then MUST propose the exact keyPath + clamped value + a before/after diff ("burn alerts: on → off, on all machines") and get the operator's confirmation before writing. The CLAUDE.md template carries the catalog trigger and the show-diff-before-write rule. A request matching a REJECTED key is answered with that key's recorded rejection reason.

### D6. The safety net (Option B as net)

The machine-coherence guard gains one comparison dimension. Each machine's advert carries:

- `overlayGeneration` — the max HLC across the local store's records + tombstones (a monotonic per-store watermark; defined here, built as part of this spec).
- `overlayEffectiveHash` — canonical hash, version-prefixed: `v1:` + sha256 of `sortedAllowlistedKeyPaths.map(k => `${k}=${JSON.stringify(effectiveValue)}`).join('\n')`, where `effectiveValue` is the post-clamp value the machine actually resolved (absent keys omitted; enum casing as stored; numbers via JSON canonical form). Exact canonicalization is normative — hash mismatch must mean value mismatch, never formatting noise.

Divergence classification (all grace-gated by the existing confirm-ticks discipline, riding the #1456 calm episode flow — no new alerting surface, no new watcher):
- **Generation lag** (peer's generation behind the pool max): sync-lag — expected during catch-up; becomes a skew row only past the existing staleness ceiling.
- **Same generation, different hash, machine `pending-restart` within its restart-governance window:** apply-lag — grace-gated like version-skew, silent.
- **Same generation, different hash, NOT pending (or pending past the window):** a real overlay bug ⇒ skew row in the existing episode flow.

Because a running machine persists received records immediately (D4), "behind and unaware" cannot exist: a machine is either generation-lagged (sync visible), apply-lagged (pending visible), or genuinely diverged (episode).

## Threat model (honest residuals)

- **Peers are the agent's own mesh-authenticated machines.** A fully compromised peer machine is largely outside this store's threat model (such a peer can already do far worse than tweak noise knobs); defense-in-depth still applies: bounded-drift quarantine caps HLC abuse, schema quarantine rejects malformed records, the allowlist caps the value space to noise, and suppression-class writes are always surfaced.
- **A misbehaving agent SESSION in an operator-bound topic can write quiet-settings without a fresh human confirmation at the API layer** (the confirmation lives in the conversational contract, which a misbehaving session could skip). Residual harm is bounded to: noise knobs only (never capability), durable attribution (`setBy` + audit), suppression-class notices that surface self-quieting to the operator, tombstone reversibility, and the restart daily-cap bounding disruption. Accepted for v1; a PIN-gated write mode is a possible later hardening, deliberately not required for noise-class keys.
- **Bearer-token theft** ⇒ the thief can write noise knobs attributed to the topic's operator. Same bounded blast radius; the census + notices are the detection surface.

## Decision points touched

| Decision point | Classification | Notes |
|---|---|---|
| Allowlist membership + clamps (single shared funnel, all entry paths) | **invariant** | Deterministic set membership + typed clamps against a code-defined closed list; violation ⇒ whole-record refusal/quarantine. The safety story REQUIRES no judgment here. |
| Conflict resolution (LOW tier, HLC latest-writer + flag) | **invariant** | Deterministic HLC ordering (foundation-verified); flag projected to census + /state/conflicts; operator holds the appeal path. |
| Write/delete principal check (verified operator required) | **invariant** | Structural refusal on unresolvable principal; `setBy` recorded as historical fact, never live authority. |
| Restart governance (coalesce, dwell, daily cap, clean window) | **invariant** | All bounds are named constants (90s clean-window, 15m dwell, 4/day cap, 24h pending-stale ceiling); conservative default = defer, level-marker persists, visibility guaranteed. A wrong "not now" only delays apply. |
| Suppression-class notice emission | **invariant** | Fires iff the written key's allowlist entry carries `suppressionClass` and the write flips it to its suppressing value — pure table lookup. |
| Corrupt-store fallback at boot | **invariant** | Deterministic detection (unparseable file OR any record failing schema on load ⇒ skip record; unparseable file ⇒ quarantine-aside + boot on file values + loud log). Conservative default = the machine's own config file. |
| Census pool-merge dark-peer handling | **invariant** | Dark peer ⇒ explicit `failed` row (deterministic omission-with-name), never silent. |
| Overlay-vs-pool divergence flagging (D6) | **judgment-candidate (inherited)** | Rides the machine-coherence guard's existing episode flow and its existing floor: bounded action space (raise/hold/resolve, signal-only), conservative default (calm/silent), deterministic dedupe + escalation ceiling (#1456). This spec adds comparison INPUTS (generation, hash), not a new arbiter. |

## Multi-machine posture

- **Overlay records** — `unified`: replicated via the WS2 journal (`multiMachine.stateSync.operatorSettings`), tombstoned deletes, LOW-tier conflict surfacing. This store is the feature.
- **Per-machine application state** (`applied` / `pending-restart` + generation) — `proxied-on-read`: genuinely per-machine runtime state, served merged via `GET /operator-settings?scope=pool` (dark-peer-tolerant with explicit failed rows). Derived, self-healing at each boot; replicating it would add nothing but staleness.
- **`operatorSettings.autoRestartToApply` config lever** — machine-local BY DESIGN; `machine-local-justification: operator-ratified-exception` (the operator-approved design brief and this spec's approval cover it: it is the per-machine "how changes land HERE" operational lever, and overlay-setting it is a bootstrap circularity — see D2 rejected list; artifact ref: this spec's approved frontmatter + PR).
- **The base config file** — machine-local BY DESIGN, pre-existing and unchanged by this spec; `machine-local-justification: physical-credential-locality` (it carries ports/paths/per-machine service bindings and secret refs that physically belong to one disk; the overlay exists precisely so operator noise-intent stops living there).
- **User-facing notices** — the suppression-class notice + pending-stale line ride the EXISTING attention hub with per-write / per-machine+generation dedupe, raised once by the machine that applies/holds the state (no pool-wide double-raise: the raise is keyed to local state only). D6 rides the existing one-raiser-elected episode flow.
- **Generated URLs** — none introduced.

## Frontloaded Decisions

1. **Conflict tier = LOW** (latest-writer + flag), diverging from preferences/learnings' HIGH tier — a config value needs exactly one winner. Foundation-verified (UnionReader LOW-tier semantics).
2. **Initial allowlist = the 17 keys in D2**, with recorded rejections (including both topic-id keys — deferred until target-authority validation exists) and the suppression-class column as shipped metadata.
3. **`autoRestartToApply` default = true**, machine-local config, NOT overlay-settable (rejected-list entry). The store ships dark → dryRun → live on the graduated ladder.
4. **Overlay never rewrites config.json** — separate layer, single merge seam, source-tagged /guards.
5. **Tombstone = return-to-file**, with the per-machine effective-value preview on DELETE and in the conversational confirmation. No per-machine exemption mechanism.
6. **Write authority = Bearer + verified topic-bound operator provenance**, on POST and DELETE alike. `setBy` is historical attribution, never live authority.
7. **Local store = `.instar/state/operator-settings.json`** (atomic writes; records + tombstones + `generation` + `lastEffectiveHash` metadata). Boot reads ONLY this file (no journal-replay wait).
8. **`overlayGeneration` = max HLC across local records + tombstones**; advert carries `(overlayGeneration, overlayEffectiveHash)` with the v1 canonical hash defined in D6. Building the advert field is part of this spec's build.
9. **Restart governance constants:** clean-window = existing 90s-quiet predicate re-verified at fire; dwell 15 min; daily cap 4; pending-stale ceiling 24h. All tunable under `operatorSettings.*` machine-local config; defaults as named.
10. **Application state machine** as defined in D4 (generation-stamped at boot; level-based pending marker; no timeouts, visibility ceilings instead).
11. **Corrupt-store handling:** per-record schema skip; unparseable file ⇒ quarantine-aside (rename, never delete) + boot on file values + loud log + posture breadcrumb.
12. **Dashboard surface (read or write) is explicitly OUT of this spec** — a follow-on increment tracked under Close the Loop at build time (the census API is the v1 read surface; conversational is the v1 write surface). Not tagged cheap: it is a published operator interface and gets its own decision when built.
13. **Single-machine behavior** — local overlay fully functional (funnel, census, boot merge, notices); replication inert.
14. **Suppression-class membership** = the 3 keys marked in D2; the notice text pattern and its hub routing are fixed at build time within the existing attention-item shape (no new surface).

## Open questions

*(none — all decisions frontloaded above)*

## Failure honesty

- Journal/store sync dark or wedged → machines keep their file values (or last-synced overlay); census shows generation lag; nothing blocks.
- Partition double-write → latest-writer wins, overwrite flagged on the census row AND `/state/conflicts`; one calm surfacing.
- Malformed/hostile replicated record → whole-record quarantine at the schema seam, counted, quarantine-visible — never applied, never "pass with flag."
- Restart window never clean / cap reached → level marker persists, census + /guards show pending, the 24h pending-stale line surfaces it. No forced restart under live work, no infinite retry (level-based, dwell + cap bounded).
- Overlay store file corrupt at boot → quarantine-aside + boot on file values + loud log; /guards shows `source: file` everywhere (no fabricated overlay).
- Older-version peer (pre-operatorSettings) receives `operator-setting-record` → silently ignored per the foundation's unknown-kind forward-compat; that machine keeps file-only behavior with no errors and no false alerts, and picks the store up when it updates.
- Feature disabled after use → the foundation's un-merge semantics apply: replicated contributions drop (quarantined-aside, reversible); each machine reverts to file values at its next boot; a pending-restart marker is cancelled by the disable (nothing left to apply). Local records are quarantined-aside, never destructively deleted.

## What this does NOT do

- No general config sync, no fleet-management plane — allowlisted noise knobs only.
- PATCH /config semantics untouched (the overlay wins over the file for allowlisted keys; /guards shows the source honestly).
- Cannot disable safety floors, its own transport, structural flags, or redirect alert routing — by allowlist construction.
- No new watcher, no new escalation authority; the two notice lines (suppression-class, pending-stale) ride the existing attention hub with dedupe.

## Testing (four tiers)

- **Unit:** shared-funnel validation (member/non-member/clamps, every entry path), `resolveEffectiveConfig` precedence + source map + pass-through, schema receive-clamps + quarantine-on-violation, tombstone semantics + high-water guard, LOW-tier conflict flag projection, canonical-hash stability (formatting/ordering/enum-case invariance), generation monotonicity, restart-governance bounds (coalescing, dwell, cap), state-machine transitions, boot drift canary, **concurrent writes ⇒ one stable effective value across repeated boots** (the LOW-tier integration proof).
- **Integration:** POST/DELETE/GET routes (auth, principal-refusal, clamp-refusal, 429, 503-when-dark), census catalog + rejected-keys + `overwriteFlagged`, /guards source marker + pending posture, suppression-class notice emission + dedupe, DELETE per-machine preview, `?scope=pool` merge with an explicit dark-peer failed row.
- **E2E:** boot with an overlay record present ⇒ guard constructed with the overlay value (the rejoin case — the single most important test); overlay change on a running server ⇒ persisted immediately ⇒ pending ⇒ clean-window restart ⇒ applied + generation stamped; partitioned concurrent writes then heal (conflict flag + one winner); set→delete→set across a partition (tombstone race sanity); wiring-integrity (dual registries, reader seams non-null).
- **Test-as-Self / live proof (Live-User-Channel Proof standard):** an operator-role session drives the REAL conversational surface end-to-end — "quiet the machine-drift alarms everywhere" ⇒ agent proposes exact key + diff from the census catalog ⇒ confirm ⇒ write ⇒ verify effective posture. Then the **live-pair ancestor-incident replay before fleet:** set a quiet-knob on machine A with machine B offline; boot B; B must come up quiet.

## Migration & awareness

- **No data migration:** the overlay starts empty; existing file values remain authoritative until the operator sets a key.
- Config defaults via `migrateConfig()` (existence-checked): `multiMachine.stateSync.operatorSettings` dark block + `operatorSettings` machine-local block (autoRestartToApply, governance constants).
- CLAUDE.md template (Agent Awareness Standard): the census route + enumerated catalog, the proactive trigger (an operator noise/quieting decision goes through the overlay whenever the key is allowlisted — never a bare per-machine config edit), the show-diff-before-write rule, the rejected-keys list WITH reasons (so the agent explains refusals: "I can't overlay that — it gates the overlay's own transport"), and Registry-First (effective value + source come from /guards + /operator-settings, never guessed).
- Forward-compat during rollout: old-version peers ignore the new kind (foundation contract, restated in Failure honesty).
