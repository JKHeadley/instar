---
title: "State-Coherence Registry — the census of every durable state category"
slug: "state-coherence-registry"
author: "echo"
eli16-overview: "STATE-COHERENCE-REGISTRY.eli16.md"
status: "draft"
layer: "core-instar-primitive"
parent-principle: "Structure > Willpower — state declares its coherence class at birth; the sync layer enforces it"
project: "multimachine-coherence"
census-date: "2026-06-05"
census-method: "dual-pass: source sweep of JKHeadley/main + live-disk ground truth on the echo agent home (laptop)"
---

# State-Coherence Registry

> **What this is:** the complete classified inventory of every durable state
> category an instar agent holds — the P0 deliverable of the
> `multimachine-coherence` project, and the registry the sync layer (P1+)
> will be built FROM. Axes defined in
> `MULTI-MACHINE-COHERENCE-MASTER-SPEC.md` §3.
>
> **What it is for:** a category's row decides its transport (git-coarse /
> peer-hot / encrypted-secret / none), its conflict handling, and whether the
> gap-check reflex watches it. Unclassified state = accidentally
> machine-local = the EXO failure. When the machine-readable form lands (P1),
> a CI lint fails any durable store not declared here.

## 1. Headline findings

1. **~100 durable state categories exist; exactly ONE truly replicates today**
   (the secret vault, via cross-machine secret sync). A handful more ride
   git-sync *where it runs* — but `SourceTreeGuard` disables git-sync on
   dev-agent homes and `gitBackup` is off on some machines, so in practice
   git-synced categories are ALSO machine-local on real fleet machines.
2. **Twelve must-be-coherent categories have NO working sync** (§3 — the
   work-list). These are the agent's "mind": commitments, attention queue,
   relationships, users, topic-project bindings, message threads, threadline
   conversation state, autonomous working artifacts, soul/identity documents,
   job definitions, project registry, learned preferences.
3. **Several stores MIX coherence classes inside one file** (§5 —
   split-required). `config.json` holds per-machine fields (port, paths) AND
   fleet-wide intent (feature flags, messaging config) in one JSON; `jobs.json`
   mixes declarative job definitions (coherent) with run state
   (machine-local). These need field-level splits before naive sync would be
   safe — syncing them whole would clobber per-machine fields (the
   secret-sync anti-clobber lesson at field granularity).
4. **A new sub-class emerged from the census:** `coherent-on-demand` — state
   that need not continuously replicate but MUST be fetchable when its topic
   moves (autonomous working files, session artifacts). This is exactly P2's
   working-set handoff, and it is much cheaper than continuous replication.
5. **Audit streams are already per-machine append-only** (reap-log,
   sentinel-events, security.jsonl, decision-journal, job-runs…) — i.e. they
   are already journal-shaped. P1's coherence journal adds a NEW stream of
   cross-machine-relevant events; it does not need to retrofit these, only
   (optionally, later) replicate chosen ones read-only.
6. **Hygiene byproduct (live-disk):** 782 orphaned `semantic.db.corrupt.*`
   recovery artifacts; three 0-byte orphaned `pending-relay.db` files at
   legacy paths; 11 timestamped `config.json` backups; `destructive-ops.jsonl`
   at 411MB with no rotation policy; stale legacy singletons
   (`anti-patterns.json`, `quick-facts.json`, `project-registry.json`, May 20
   vintage). Filed as a cleanup work-list (§7) — not this initiative's goal,
   but the census pays for itself.

## 2. How to read the tables

- **Class** = coherence class: `COHERENT` (must-be-coherent) ·
  `ON-DEMAND` (coherent-on-demand) · `LOCAL` (machine-local-by-design) ·
  `DERIVED` (rebuildable cache) · `AUDIT` (append-only per-machine stream)
- **Fresh** = freshness need: `RT` realtime · `EV` eventual ·
  `SB` session-boundary · `AR` archival
- **Conflict** = conflict shape: `1W` single-writer · `AO` append-only
  mergeable · `LWW` last-writer-wins · `SET` set-union
- **Sync today** = what actually runs on real machines (not what code paths
  nominally exist)
- **Target** = transport class this registry assigns (master spec §5/P3)

## 3. THE WORK-LIST — must-be-coherent, no working sync today

Priority-ordered (user-visible damage when incoherent, first):

| # | Category | Store | Fresh | Conflict | Sync today | Target | Phase |
|---|----------|-------|-------|----------|------------|--------|-------|
| 1 | **Commitments** | `state/commitments.json` (940K live) — CommitmentTracker CAS | EV | 1W today → AO desired | none | peer-hot (journal mutations P1; store convergence P1.5 — master spec open Q1) | P1 |
| 2 | **Attention queue** | `state/attention-items.json` + suppressed.jsonl | EV | 1W | none | peer-hot | P1+ |
| 3 | **Topic↔machine placement history** | (does not exist yet — pool state holds only CURRENT owner) | EV | AO | n/a | peer-hot — the journal's first stream | P1 |
| 4 | **Autonomous working artifacts** | `.instar/autonomous/<topicId>.local.md` + declared artifact paths | SB (on transfer) | 1W (topic-owner) | none — THE EXO FAILURE | **ON-DEMAND**: working-set pull on move | P2 |
| 5 | **Threadline conversation state** | `threadline/conversations.json` (58K live, RMW), context-thread-map, thread-resume-map, telegram-bridge-bindings | EV | 1W per conversation | none | peer-hot (registry events P1 taxonomy; full semantics P3) | P3 |
| 6 | **Message store & threads** (A2A) | `.instar/messages/store/` (~686 msgs), `threads/`, inbox/outbox JSONL indexes | EV | per-file 1W + AO indexes | partial (peer push on send; no reconciliation) | peer-hot + gap-check digests | P2+ |
| 7 | **Topic-project bindings** | `topic-project-bindings.json` | EV | LWW | none | peer-hot | P1+ |
| 8 | **Relationships** | `relationships/<id>.json` (per-person files) | EV | per-file LWW | none (git-sync path exists, not running) | peer-hot | P2+ |
| 9 | **Users registry** | `users.json` | EV | LWW | none (same caveat) | peer-hot | P2+ |
| 10 | **Job definitions** (declarative half) | `jobs.json` + `.instar/jobs/*.md` | EV | LWW | none | git-coarse where tracked, peer-hot else — **after field split (§5)** | P2+ |
| 11 | **Soul / identity documents** | `soul.md`, `identity.json`, self-knowledge facts | SB | 1W (human/agent-curated) | none running | git-coarse + peer-hot fallback | P2+ |
| 12 | **Projects registry + plan-docs** | `.instar/projects/*.md`, projects digest cache | EV | 1W (owner-machine claim exists!) | claim-ownership verb exists; content does not sync | peer-hot (note: `claim-ownership` already models ownership — reuse) | P2+ |
| 13 | **Learned preferences / corrections** | `.instar/preferences.json`, correction-ledger.db | EV | AO-ish | none | peer-hot | P3+ |

**Already solved (the prototypes):** secret vault (`config.secrets.enc` —
secret-sync, X25519-sealed push, receive-only default) · current topic
ownership (session-pool CAS + lease) · conversation live-tail (seamlessness
spec, holder→standby).

## 4. Full inventory by class

### 4a. COHERENT / ON-DEMAND — covered in §3 (13 entries + 3 solved)

### 4b. LOCAL — machine-local-by-design (correctly local; registry declares it)

| Category | Store | Why local is correct |
|----------|-------|---------------------|
| Machine identity + signing/encryption keys | `machine/identity.json`, `*.pem` (0600) | Identity IS the machine; never synced by definition |
| Per-session state | `state/sessions/<id>.json` (54 live) | Sessions live and die on one machine; pool transfers create NEW sessions (CONTINUATION), not file copies |
| Job RUN state (executions, active-job) | `state/jobs/*`, `active-job.json`, run history ledger | Runs are machine events; definitions are the coherent half (§3#10) |
| Quota state | `quota-state.json` | Per-account-seat per-machine — but **broadcast-view via capacity heartbeats already ships** (quota-aware placement); registry notes the view channel |
| Resource samples (CPU/RSS) | ResourceLedger SQLite | Physical per-machine telemetry |
| Lease/coordination state | `lease-local.json`, registry liveness | The lease IS the cross-machine protocol; its state is the protocol's own |
| Nonce/sequence watermarks | NonceStore | Replay protection is per-channel per-machine by design |
| Relay delivery queues | `pending-relay.<agent>.sqlite`, message-ledger sqlite | Outbound queue drains on the machine that owns the channel seat |
| Telegram/iMessage/WhatsApp/Slack adapter state | poll offsets, chat.db, consent.json | Channel seat is held by one machine (lifeline); failover = seat transfer, not state merge |
| Platform attachment caches | telegram-images/ (9.4M), documents/ | Fetchable from platform on demand |
| Listener-daemon internals | inbox/outbox.jsonl.active, pid, sentinels, hmac key | Daemon-local IPC |
| Threadline transport internals | relay-tokens, mcp-tokens, rate-limits | Connection-scoped; identity-keys are LOCAL-secret like machine keys |
| Process/restart coordination | boot-id, restart markers, auto-updater state, caffeinate pid | Per-process lifecycle |
| Per-boot/ephemeral caches | paste/, stop-gate.db, feature-registry.db, capability manifest | Recomputed or per-machine detection |
| Trust elevation/incidents (external-op gates) | `state/trust-*.json` | Debatable — trust earned on one machine arguably transfers; **flagged as a P3+ review item** rather than silently local |

### 4c. AUDIT — append-only per-machine streams (journal-shaped already)

`destructive-ops.jsonl` (411M — needs rotation, §7) · `job-runs.jsonl` (4M) ·
`reaper-audit.jsonl` (1.1M) · `reap-log.jsonl` · `sentinel-events.jsonl` ·
`security.jsonl` · `decision-journal.jsonl` · `activity-*.jsonl` (37M,
date-partitioned) · `watchdog-interventions.jsonl` · `operation-log.jsonl` ·
trust-audit-chain.jsonl · telegram-messages.jsonl (5.2M) · a2a-sent/received ·
prompt-gate-audit · recovery-events · skill-telemetry · feedback.jsonl ·
apprenticeship-decisions.jsonl · coherence-journal (P1, new).

Classification: `AUDIT`, conflict `AO`, sync `none` → target: stay local;
chosen streams become read-only replicable via the P1 mechanism IF a
pool-wide read surface is wanted (e.g. reap-log for "where did my session
go?" answered from any machine). Not initial scope.

### 4d. DERIVED — rebuildable caches (declared, never synced)

Token ledger (SQLite, rebuilt from Claude JSONL transcripts) · semantic.db /
memory.db / episodes (rebuildable from evidence; **live-disk: semantic.db +
memory.db stale since Jun 1 — investigate separately**) · topic-memory.db
(16M, active — **master spec open Q2: promote to COHERENT?**) · project-map
(refreshable scan) · projects-digest.cache · docs-code-sync.json ·
MemoryIndex · framework-model-preferences.db · discovery.db.

### 4e. Uncertain / needs owner verification (census honesty)

| Item | Question |
|------|----------|
| `state/instructions-tracking/` (59M, 15,180 UUID-keyed JSONL files!) | Source census didn't map an owner; volume says it matters. Owner + rotation + class needed. |
| TopicIntentStore location | Code references it; on-disk location unverified. |
| `shared-state.jsonl` (SharedStateLedger) | Nominally the git-synced cross-machine ledger — is anything consuming it on real machines? May be the vestigial ancestor of the P1 journal. |
| `correction-capture-backlog.db` vs `correction-ledger.db` | Two stores, one sentinel — which is canonical? |
| ProjectRoundWorktrees / TaskFlow stores | Routes-managed; durable form unverified. |

## 5. Split-required stores (mixed coherence classes in one file)

| Store | Coherent fields | Machine-local fields | Risk if synced whole |
|-------|-----------------|---------------------|----------------------|
| `config.json` | feature flags, messaging[] (already secret-extracted), monitoring tunables, multiMachine policy | `port`, machine paths, dashboardPin?, machine-specific tier settings | One machine's port/paths clobber another's → boot collision (the Inspec 4041 incident class) |
| `jobs.json` | job definitions (cron, prompt, supervision) | enabled-state overrides?, last-run bookkeeping | Run state from machine A overwrites B's scheduler bookkeeping |
| `.instar/state/session-pool/` | pool topology, placement pins | per-machine session handles | Already CAS-protected; listed for completeness |

Rule adopted into the master spec: **no whole-file sync for split-required
stores** — either field-level extraction (the `{secret:true}` pattern
generalized, e.g. `{machineLocal:true}` annotations) or store split precedes
any sync.

## 6. Registry maintenance (how this stays living)

1. **This doc is authoritative** until `src/data/state-coherence-registry.json`
   lands with P1's first consumer; from then the JSON is authoritative and
   this doc is its rendered companion.
2. **CI lint (P1):** durable-write sweep (writeFileSync/appendFile/SQLite-open
   under state dirs) → every store must match a registry entry, else FAIL.
   New state declares its class at birth.
3. **Census refresh:** re-run the dual-pass census when the lint fires on
   unknown stores, and at each phase boundary; update `census-date`.

## 7. Hygiene work-list (byproduct — file separately, not this project)

- Purge 782 `semantic.db.corrupt.*` + recovery-marker orphans (~250K, all
  failed recovery attempts).
- Delete three 0-byte legacy `pending-relay.db` files (`state/`, `.instar/`,
  and `.instar/state/pending-relay.sqlite3`) — live queue is
  `.instar/state/pending-relay.<agent>.sqlite`.
- Rotation policy for `destructive-ops.jsonl` (411M) and the activity
  partition family (37M) — date-partition + archive like activity logs.
- Retire stale legacy singletons: `anti-patterns.json`, `quick-facts.json`,
  `project-registry.json` (May 20 vintage, no live writers found).
- Consolidate the 11 ad-hoc `config.json.bak*` files into one rotation
  scheme.
- Investigate semantic.db/memory.db staleness (no writes since Jun 1) — is
  the memory layer silently dead on this machine?

## 8. Census provenance

Dual-pass, 2026-06-05: (a) source sweep against `JKHeadley/main`
(every durable-write site in src/core, monitoring, messaging, memory, users,
scheduler, server, threadline) — ~100 categories; (b) live-disk ground truth
on the echo agent home, laptop (1.7G under `.instar/`, 943 top-level items,
60+ files written within 30 min of the census — the freshness column is
real). Two categories the source pass missed were caught by the disk pass
(instructions-tracking, mentor stores); uncertainties are §4e, not silently
dropped.
