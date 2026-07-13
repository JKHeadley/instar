# Quiet-Settings Follow the Agent — Replicated Operator-Settings Overlay

**Status:** DRAFT — pre-convergence
**Direction:** Approved by operator 2026-07-12 ("proceed with your recommendations" on the design brief): **Option A scoped tight** — a replicated operator-settings overlay limited to an allowlisted set of noise/narration keys, **auto-apply**, with the machine-coherence guard as the divergence safety net (Option B as net, Option C's push-on-set as delivery optimization).
**Parent principle:** Structure > Willpower; One Memory (WS2 replicated stores); "quiet decisions must follow the agent, not the machine."
**Ancestor incident:** 2026-07-11 — operator quieted alert noise; the quieting landed in ONE machine's config file; the Laptop rejoined the mesh two days later with the OLD settings and re-flooded the Attention hub.

---

## 1. Problem

Operator intent expressed as per-machine config silently forks across machines. When the operator says "quiet these alerts," today that decision becomes an edit to `.instar/config.json` on whichever machine handled the conversation. Every other machine — especially one OFFLINE at decision time — keeps the old values and re-applies stale behavior when it rejoins. The 2026-07-11 re-flood is the defining case: a broadcast write could not have fixed it (the Laptop wasn't there to receive it); only a durable, replicated record that the rejoining machine reads on boot closes the class.

## 2. Scope

**In scope (the allowlist class):** operator-intent knobs that shape narration/noise — `monitoring.*` alert enable/dryRun/threshold levers, alert routing toggles, burn-detection toggles, and the calm-alerting levers shipped in #1456.

**Out of scope, by construction:**
- Machine-genuine locality (ports, paths, hardware tuning, per-machine nicknames).
- Secrets (they have their own encrypted sync).
- Structural flags with blast radius: `developmentAgent`, `multiMachine.*` topology, `scheduler.enabled`, anything money-adjacent (`routingSpend.*`), any `stateSync.*` flag (the overlay must not be able to gate its own transport).
- Dry-run/enable flags of guards that ARE the safety floor (e.g. `permissionPromptAutoResolver`) — the overlay is a noise-shaping surface, never a safety-disabling surface.

## 3. Design

### 3.1 A new replicated store kind: `operatorSettings`

Rides the WS2 replicated-store foundation exactly like preferences (WS2.1) and learnings (WS2.2):

- **Store key** `operatorSettings`, **record kind** `operator-setting-record`, registered via `replicatedKindRegistry.register(OPERATOR_SETTINGS_KIND_REGISTRATION)` in the server boot path AND listed in `CoherenceJournal.JOURNAL_KINDS` (the dual-registry coupling; CI wiring test extends automatically).
- **Record identity:** `recordKey` = the canonical config key path (e.g. `monitoring.machineCoherence.dryRun`). One record per key — the whole overlay is the union of records.
- **Record fields (schema-clamped on receive):**
  - `keyPath` (string, MUST be a member of the code-defined allowlist — see 3.2; non-allowlisted keyPath ⇒ whole record rejected at receive, counted, never applied)
  - `value` (type-clamped per-key: boolean / enum / bounded number — the allowlist entry carries the clamp)
  - `setAt` (ISO-8601-only), `setBy` (verified-operator provenance: platform + uid — content-names refused, Know Your Principal), `sourceMachine` (machine id), `note` (length-bounded free text, optional)
- **Tombstones:** deleting an overlay key (op `delete`) returns that key to the machine-local file value everywhere, including on machines offline at delete time (no resurrection).
- **Conflict tier: LOW-impact** (HLC latest-writer wins, overwrite FLAGGED, never silent). Rationale: a noise knob must resolve to ONE effective value; the stakes are bounded by the allowlist (worst case: an alert is louder/quieter than intended until the flag is seen). This diverges from preferences/learnings (HIGH tier) deliberately — an "append both variants as hints" answer is meaningless for a config value.
- **Bounds:** small store — retention budget 256 KiB, rate-cap ~20 capacity / 5 refill-per-sec (an overlay is dozens of keys, not thousands).
- **Ships dark:** `multiMachine.stateSync.operatorSettings: { enabled: false, dryRun: true }` — graduated ladder, dev machines first (the usual WS2 rollout). Single-machine agents: strict no-op (the local write path still works; replication is inert).

### 3.2 The allowlist (code-defined, never config-defined)

A single exported constant `OPERATOR_SETTINGS_ALLOWLIST: Record<keyPath, { type, clamp }>` in the store module. Initial membership (each entry names its consuming guard):

- `monitoring.machineCoherence.dryRun`, `.calmEnabled`, `.calmRaiseNotify`, `.silentResolveNote`, `.patchSkewPriority`, `.calmWaveThreshold`, `.skewFlapThreshold` (the #1456 calm levers)
- `monitoring.burnDetection.enabled`, `.absoluteShareThreshold`, `.alertTopicId`
- `monitoring.ropeHealth.enabled`, `.urgentEnabled`, `.digestTopicId`
- `monitoring.sentinelTelegramEscalation`
- `monitoring.activeWorkSilenceSentinel.enabled`, `.silenceThresholdMs`
- `promiseBeacon.suppressUnchangedHeartbeats`, `.beaconLivenessIntervalMs`
- `monitoring.reapNotify.enabled`
- `meshTransport.recoveryProbeEnabled` — **REJECTED from allowlist** (transport-structural, not noise) — listed here to record the decision.

The allowlist lives in code so membership changes ride PR review + the release train, never a runtime write. A write (local or replicated) naming a non-member keyPath fails closed.

### 3.3 The overlay-resolution seam (precedence rule)

**The config file is never rewritten by the overlay.** The overlay is a separate durable layer merged at ONE seam:

- New pure function `resolveEffectiveConfig(baseConfig, overlayRecords)` → effective config + per-key source map (`file` | `overlay`). Precedence: **overlay > file, for allowlisted keys only**; every other key passes through untouched.
- Called at server boot, after config load and before guard construction — so every boot-read guard (the majority; verified: guards resolve config once at construction) sees effective values with zero per-guard changes.
- `guardPosture.resolveGuardConfigSnapshot()` (which re-reads disk deliberately) applies the same overlay merge, so `GET /guards` reports the guard's REAL effective posture, with a new per-row `source: overlay` marker when an overlay key decided it. The guard-posture tripwire compares effective-vs-effective across boots (an overlay-driven change is attributed to the overlay, not flagged as a mystery config edit).
- **Returning control to the file** = tombstone the overlay key (one lever, crisp semantics). There is no per-machine "exempt" escape hatch — that would re-create per-machine forks.

### 3.4 Auto-apply (the approved behavior)

Two cases, honestly distinguished:

1. **Rejoining/booting machine (the incident class):** the overlay is read at boot before guard construction — the stale-rejoin case is covered with NO extra machinery. This is the load-bearing fix.
2. **Already-running machine receiving an overlay change:** guards are boot-read, so the new value is not live yet. The applier marks the machine `overlay-pending-restart` (surfaced on `GET /guards` as the existing `diverged-pending-restart` posture class, and on the new `GET /operator-settings` census). Because allowlisted keys are noise-knobs (bounded blast radius), the applier then schedules a **guard-refresh restart at a clean window** via the existing restart-request signal machinery (no in-flight forwards, no queued messages, no recent traffic — the same gating the lifeline drift-promoter uses). Lever: `operatorSettings.autoRestartToApply` (default true on the dev ladder; the graduated rollout may ship it false-first). If the restart is declined/deferred, the pending state stays visible — never silent.

### 3.5 Write path (conversational-first)

- `POST /operator-settings` (Bearer) with `{ keyPath, value, note? }`: validates against the allowlist + clamp, stamps verified-operator provenance from the requesting topic's bound operator (a write with no resolvable principal is refused), persists locally, emits to the journal. The emit IS the push-on-set (Option C as delivery optimization — journal sync delivers to online peers in seconds; the store replay covers offline peers).
- `DELETE /operator-settings/:keyPath` → tombstone.
- `GET /operator-settings` → the census: every overlay key with value, setBy, setAt, origin machine, and THIS machine's application state (`applied` | `pending-restart`), plus flagged overwrites.
- The conversational surface is primary: "quiet the machine-drift alarms everywhere" → I propose the exact keyPath+value back in plain words, confirm, write. The route is the mechanism, not the UX.

### 3.6 The safety net (Option B as net)

The machine-coherence guard gains one comparison dimension: each machine's advert carries a hash of (overlay generation, effective-values-of-allowlisted-keys). A machine whose effective values diverge from the pool's overlay past the existing confirm-ticks discipline = a skew row in the existing episode flow — catching bugs in the overlay machinery itself (the guard that watches the fix, per the brief). No new alerting surface; it rides the calm-alerting behavior shipped in #1456.

## 4. What this does NOT do

- It does not make config.json replicated, general config sync, or a fleet-management plane. Only allowlisted noise knobs, only via the overlay.
- It does not touch PATCH /config semantics (that surface keeps editing the local file; the overlay wins over it for allowlisted keys, and /guards shows the source honestly).
- It cannot disable safety floors, its own transport, or structural flags — by allowlist construction.

## 5. Failure honesty

- Journal/store dark or wedged → machines keep their file values; the census shows replication state; nothing blocks.
- Two machines set the same key during a partition → latest-writer wins, overwrite flagged on `GET /operator-settings` and `/state/conflicts` (LOW tier), one calm surfacing — never silent, never a block.
- A malformed/hostile replicated record (bad type, non-allowlisted key, oversized note) → whole-record rejection at the schema seam, counted, quarantine-visible — never applied.
- Restart-to-apply declined or window never clean → `pending-restart` stays visible on /guards and the census; the coherence net eventually flags persistent divergence. No infinite retry storm (the restart request is level-based, not edge-spammed).

## 6. Testing (three tiers, per the Testing Integrity Standard)

- **Unit:** allowlist validation (member/non-member/clamps), resolveEffectiveConfig precedence + source map, schema receive-clamps (type, ISO dates, bounded note, non-allowlisted keyPath rejection), tombstone semantics, LOW-tier conflict flag.
- **Integration:** POST/GET/DELETE routes (auth, principal-refusal, 503-when-dark), overlay reflected in /guards effective posture + source marker, pending-restart lifecycle.
- **E2E:** production-init path — boot with an overlay record present ⇒ guard constructed with the overlay value (the rejoin case, the single most important test); overlay change on a running server ⇒ pending state ⇒ restart ⇒ applied; wiring-integrity (dual-registry, reader seams non-null).
- **Live-pair verify before fleet:** set a quiet-knob on machine A with machine B offline; boot B; B must come up quiet. (The literal ancestor incident, replayed as proof.)

## 7. Migration & awareness

- Config default block via `migrateConfig()` (existence-checked): `multiMachine.stateSync.operatorSettings` dark defaults.
- CLAUDE.md template section (Agent Awareness Standard): the census route, the conversational trigger ("quiet X everywhere" → overlay write, never a bare config edit), and the Registry-First rule (effective value + source from /guards + /operator-settings, never guessed).
- No data migration: the overlay starts empty; existing file values remain authoritative until the operator sets a key.
