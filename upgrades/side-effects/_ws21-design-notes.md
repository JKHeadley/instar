# WS2.1 — preferences pool (cross-machine) — DESIGN NOTES (working, not the artifact)

Status: in-progress build. This file is scratch for continuity across compaction;
the real side-effects artifact is authored at ship time.

## What WS2.1 is
Make the correction-learning preference store (`PreferencesManager`,
`.instar/preferences.json`) replicate across the machine pool so a preference
learned on machine A is honored on machine B. READ-side replication only
(preferences are advisory signals, never authority) — mirrors the
COMMITMENTS-COHERENCE pattern exactly.

## Substrate (already exists on main — do NOT rebuild)
- `CoherenceJournal` / `JournalSyncApplier` / MeshRpc `journal-sync` +
  `commitments-sync` verbs.
- `src/core/CommitmentsSync.ts` is the load-bearing PRECEDENT — copy its shape:
  - `buildXxxSyncPage(req, deps)` serve side: incarnation fence → stale re-pull
    from 0; delta window by `lastMutatedSeq` asc (id tiebreak), EXCLUSIVE cursor,
    byte-capped (`syncPageBytes`, ≥1 record/page); origin-stamp from deps;
    serve-time credential redaction of free-text.
  - `XxxReplicaStore`: one JSON/peer under `state/preference-replicas/`,
    single-writer, temp+atomic-rename, corrupt→quarantine+fresh, incarnation
    wholesale-replace, **forged-row rejection** (row.originMachineId !== authed
    sender → forgedRows++, never applied).
  - `mergeXxxViews(deps)`: own + replicas.

## The ONE genuine design fork (resolved — my lean, per standing directive)
Commitments use composite-key (origin,id) union with NO cross-origin merge.
Preferences DIFFER: the same `dedupeKey` on two machines is the SAME learned
preference observed independently. So the union reader COLLAPSES by `dedupeKey`:
- ordering / HLC: `(Date.parse(recordedAt), originMachineId)` lexicographic —
  newest wins for `learning`, `confidence`, `violationPattern`, `provenance`.
- `dedupeCount` = SUM across origins (true cross-machine observation count).
- `recordedAt` = max.
- Own store is authoritative for its own dedupeKey row's identity; replicas
  only contribute when their (origin,dedupeKey) is distinct OR they win recency.
Rationale: preferences are a SET keyed by dedupeKey; presenting N per-origin
rows for the same lesson would double-inject the same guidance into the
session-start block. Collapse keeps the injected block deduped and honest.

## Per-entry seq (needed for delta windowing)
PreferenceEntry has no seq today. Add additive, back-compat:
- `PreferencesStore.replicationSeq?: number` (monotonic per machine).
- `PreferenceEntry.lastMutatedSeq?: number` assigned on every upsert.
- Legacy load: entries w/o seq get assigned on next write; serve treats absent
  as 0 so a legacy store still replicates fully on first sync.

## Surfaces
- New MeshRpc verb `preferences-sync` (RBAC: any registered peer, like
  commitments-sync — reads, not mutations).
- Receive rides PeerPresencePuller cadence (same as journal-sync/commitments).
- Union reader feeds `GET /preferences/session-context` and `/preferences`
  ONLY when pool wired + flag on; plain reads unchanged otherwise.

## Flag / dark-gate (dev-agent gate, ships dark)
`multiMachine.seamlessness.ws21PreferencesPool` (bool, omit `enabled` default).
Register in DEV_GATED_FEATURES. Single-machine = strict no-op.

## Per-store bounds
Cap replicated preferences per peer (maxReplicatedPreferences, default ~500) —
preferences are few; a runaway peer can't bloat the merge.

## Phase C
No LAN assumption (per-peer HTTP over pool fabric). Peer-count-agnostic (N
machines page the same as 2). Headless: no interactive step. Quorum N/A
(read replication, last-writer-wins is monotonic, no election).

## Build order
1. [x] PreferencesSync.ts engine (pure): wire shapes, buildPreferencesSyncPage,
       PreferenceReplicaStore, mergePreferenceViews (collapse-by-dedupeKey).
2. [x] PreferencesManager: replicationSeq + lastMutatedSeq additive; expose
       getAllForSync() + advert{incarnation,replicationSeq}.
3. [ ] MeshRpc verb + RBAC case + types.
4. [ ] server.ts: serve handler + receive puller wiring + union into
       /preferences/session-context (flag-gated).
5. [ ] config flag + ConfigDefaults dark-gate line-map + DEV_GATED_FEATURES.
6. [ ] PostUpdateMigrator + CLAUDE.md template (Agent Awareness + Migration Parity).
7. [ ] Tests: engine (serve fence/delta/redact, apply forged/incarnation/quarantine,
       merge collapse-by-dedupeKey/dedupeCount-sum/recency), wiring, flag gate.
8. [ ] /instar-dev gate + MANDATORY second-pass (security-sensitive: cross-machine
       read of learned user preferences — redaction + forged-row are the teeth).
