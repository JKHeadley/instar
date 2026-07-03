---
slug: machine-coherence-guard
title: Agent Machine-Coherence Guard — pool-wide version + flag-skew detection, one alarm (Roadmap 4.1, F4/P0-1)
status: draft — awaiting spec-converge (this document is the round-0 input; no convergence or approval tags yet)
author: echo
eli16-overview: machine-coherence-guard.eli16.md
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
constitution: Cross-Store Coherence Is an Invariant (machine-registry roles vs live lease/heartbeats answer the same "who is awake" question with no declared agreement check — this spec declares and mechanizes it); A Dark Feature Guards Nothing (the F4 audit named this pattern verbatim — G3 covers guards, nothing covers seamlessness flags); Bounded Notification Surface (ONE episode-scoped attention item, never per-heartbeat or per-flag); Structure beats Willpower ("both machines manually equalized" is willpower; the guard is structure)
lessons-engaged: "P17 (ONE deduped attention item per skew episode — §4); P19 (episode latch + bounded escalation: one item on open, one on persistence, one resolution marker — never a stream — §4.3, §4.4); F4 finding family (dev-gate asymmetry silently halves a cross-machine guarantee with no alarm — §1); P0-1 (fleet version coherence has no owner — §1, §8); Verify the State, Not Its Symbol (awakeMachineCount must derive from live lease state, not last-written registry role rows — §5); the #930/A2/WS2.1/seamlessnessFlags narrowing-return class (the new advert field joins the SESSION_STATUS_ADVERT_FIELDS ratchet so the receive path cannot silently drop it — §3.2); the seamlessnessFlags/posture carry-forward pattern (a sparse liveness beat must not erase a peer's last advert — §3.2); #1001 anti-mechanism (enabled OMITTED from shipped config, resolved via resolveDevAgentGate; registered in DEV_GATED_FEATURES — §7)"
earned-from: "2026-07-02 live test-as-self matrix, finding F4 (docs/audits/test-as-self-matrix-2026-07.md, echo agent home): the same agent's two machines resolved ws13PinReplicate differently (Laptop developmentAgent:true → LIVE; Mini config lacked it → DARK), so an NL cross-machine move was acked to the user and then silently never actuated — pinState:pending forever, no alarm. Repaired in-session by hand-editing the Mini's config; the CLASS stayed open. Same audit: awakeMachineCount:0 on /health while both machines were online and the Mini held the lease (P0-1 telemetry incoherence, reproduced live on v1.3.722)."
roadmap: "instar-two-goal-roadmap-2026-07 §5 Phase 4 item 4.1 — 'Agent machine-coherence guard: pool-wide version + seamlessness-flag skew detection → ONE attention item; fix awakeMachineCount telemetry; then updater coordination (fleet version owner)'. Live proof: 'Deliberately skew a flag on one machine → alarm within one heartbeat cycle; matrix transfer scenario passes with zero manual config surgery.'"
---

# Agent Machine-Coherence Guard (roadmap 4.1)

One new sentinel, one telemetry bug-fix, one honestly-scoped later phase:

1. **The machine-coherence guard** (the build): a manifest-driven skew detector
   that compares, across every ONLINE machine in the pool, (a) the running
   instar version, (b) the resolved values of the coherence-critical
   multi-machine flags, and (c) the mesh protocol version — riding the
   EXISTING 30s capacity-heartbeat/presence-pull machinery, and raising **ONE
   deduped, episode-scoped attention item** when the pool diverges. Signal-only;
   it never blocks, equalizes, or restarts anything.
2. **The `awakeMachineCount` telemetry fix** (a bug-fix riding along, §5): the
   count published on `/health` and `GET /pool` derives from stale per-machine
   registry role rows and silently reads 0 on a read failure; it moves to the
   live lease view with an explicit source tag.
3. **Updater coordination (fleet version owner)** is Phase 2 — designed at
   sketch level here (§8), explicitly NOT in this build.
   <!-- tracked: roadmap-2026-07/phase-4.1-updater-coordination -->

## 0. The two operator-level properties this must deliver

- **(a) Skew is loud.** When the agent's own machines stop being "the same me"
  — different instar version, a dev-gated mesh feature resolving LIVE on one
  machine and DARK on the other, a protocol-version split — exactly one alarm
  names the divergent key, the machines, and the guarantee it halves. Today the
  answer is silence (F4 ran for a full live scenario before a human root-caused
  it from journal forensics).
- **(b) The alarm is one item, not a stream.** Never per-heartbeat, never
  per-flag: one episode-scoped attention item aggregating every currently-open
  skew, updated in place, auto-resolved with a marker when the pool converges,
  escalated at most once on persistence. (The Telegram-noise constitution rule:
  agent acts, user gets ONE consolidated alert.)

## 1. What broke, stated honestly (the evidence)

All evidence from the 2026-07-02 audits (echo agent home,
`docs/audits/test-as-self-matrix-2026-07.md` + `docs/audits/mm-current-state-2026-07.md`)
on v1.3.722, Laptop↔Mini live pair:

- **F4 — dev-gate asymmetry silently halves a guarantee.** The Laptop's config
  has `developmentAgent: true`, so `ws13PinReplicate`/`ws13Reconcile` resolve
  LIVE there; the Mini's config lacked the key, so the SAME flags resolved DARK.
  A user-visible NL move ("move this conversation to the mac mini") was acked —
  then never actuated: the Mini wrote the pin LOCAL-ONLY (dark emitter → no
  `topic-pin-record` journal entry), the Laptop's reconciler was structurally
  blind to it, `pinState: pending` forever. Sub-finding (a) verbatim: *"no
  mesh-wide config/flag-coherence alarm fired on the asymmetry … G3 covers
  guards, not seamlessness flags."* The repair was manual config surgery on the
  Mini plus a restart.
- **P0-1 — fleet version coherence has no owner.** The two machines were on the
  same version that night only because a human equalized them by hand. Nothing
  detects version skew, and nothing coordinates updates.
- **awakeMachineCount: 0** while both machines were online, the Mini held the
  lease, and `splitBrainState` read `clear` — a live probe on the very surface
  (`/health.multiMachine.syncStatus`) that is supposed to answer "how many
  machines think they're serving?".

The class matters more than the instances: **any dev-gated mesh feature
resolves per-machine, so a mixed pair silently halves every dev-gated
guarantee** — the agent's capabilities become a property of a machine, not of
the agent. That is a coherence (north-star) failure, not a UX bug.

## 2. Root cause, grounded in the code

Every citation below was verified in this worktree at v1.3.728.

### 2.1 Version skew: the telemetry exists in the types and is never populated

- `MachineHardware.instarVersion` exists (`src/core/types.ts:1951`) and
  `captureHardware(instarVersion?: string)` will stamp it
  (`src/core/MachinePoolRegistry.ts:27-38`) — but the ONLY production callsite
  calls it with NO argument: `poolIdMgr.recordSelfHardware(poolSelfId,
  poolMod.captureHardware())` (`src/commands/server.ts:17094`). The field is
  structurally always `undefined`.
- Downstream code already WANTS it: the `GET /guards?scope=pool` merge reads
  `capacity?.hardware?.instarVersion` to annotate a `route-missing` peer with
  its version (`src/server/routes.ts:6645`, used at `:6671`) — today that
  annotation can never appear.
- The server's truthful own-version source exists:
  `ProcessIntegrity.runningVersion` (frozen at boot — what is EXECUTING, not
  what is on disk; `src/core/ProcessIntegrity.ts:92`), already used by
  `GET /guards` (`src/server/routes.ts:6617`).
- Net: **no machine can currently see any peer's instar version**, so version
  skew is undetectable by construction.

### 2.2 Flag skew: the flags are exchanged, but nothing compares or alarms

- Each machine self-advertises `seamlessnessFlags` in its capacity heartbeat
  (built at `src/commands/server.ts:17203` inside `refreshPool`, cadence 30s at
  `:17251`) and the HTTP presence pull carries a peer's advert back
  (`src/core/PeerPresencePuller.ts:87`, pass-through ratchet
  `SESSION_STATUS_ADVERT_FIELDS` at `:101-109`). The pool view exposes them per
  machine (`src/core/types.ts:2035-2074`, assembled at
  `src/core/MachinePoolRegistry.ts:343`).
- The ONLY comparator today is `checkPoolFlagCoherence`
  (`src/core/ReplicatedRecordEnvelope.ts:665-700`) — and it is scoped to the
  `stateSyncReceive` sub-map only, surfaces as a **boot-time console log line,
  once per process** (`src/commands/server.ts:17264-17289` — the comment says
  "A richer surface (one Attention item) is the store PR's to add"), and covers
  none of the ws1x/ws4x flags, none of the top-level `multiMachine.*` posture
  (`pollFollowsLease` `src/core/types.ts:2388`, `meshTransport` `:2408`,
  `sessionPool` `:2352`, `stateSync` `:2446`), no versions.
- The F4 flags (`ws13PinReplicate`, `ws13Reconcile`) are not advertised at all
  — they are journal-emitter/reconciler-side capabilities, invisible to peers.
- `exactlyOnceIngress` resolves per machine from `sessionPool.stage`
  (`src/core/seamlessnessConfig.ts:126-128`) — a stage mismatch silently gives
  the pool a dedup ledger on one side only.

### 2.3 The dev-gate makes RAW config comparison insufficient

`resolveDevAgentGate` is `explicitEnabled ?? !!config.developmentAgent`
(`src/core/devAgentGate.ts:44-47`). F4 was NOT a differing flag value in
config — both configs OMITTED the flag; what differed was `developmentAgent`.
Any honest comparison must therefore compare **resolved effective values**
(post-gate, dry-run folded in), not raw config bytes. The fleet-uniform catalog
of gate-riding features already exists: `DEV_GATED_FEATURES`
(`src/core/devGatedFeatures.ts:45`, each entry carrying a dotted `configPath`).

### 2.4 `awakeMachineCount` counts stale symbols, not live state

- `MultiMachineCoordinator.getSyncStatus()` computes the count by loading the
  LOCAL machine registry and counting rows with `role === 'awake'`
  (`src/core/MultiMachineCoordinator.ts:967-973`); a registry read failure is
  silently coerced to **0** (`:973`, `@silent-fallback-ok` catch).
- Role rows are written only on SELF role transitions —
  `reconcileRoleToLease` early-returns when the role is unchanged
  (`src/core/MultiMachineCoordinator.ts:1186`) and only ever updates
  `this._identity.machineId`'s own row (`:1189`). A peer's row in MY registry
  changes only via registry sync + merge.
- The merge keeps, per machine id, the entry with the later `lastSeen`
  (`src/core/mergeRegistry.ts:48-53`) — but `lastSeen` is refreshed by writers
  that do NOT touch `role` (`registerMachine` `src/core/MachineIdentity.ts:380`,
  `updateNickname` `:412`), so a fresher-lastSeen-but-stale-role row can win.
  In a git-less mesh the peer rows never update at all — the in-code comment
  admits the count "misses … a git-less mesh where each machine only sees
  itself as awake" (`src/core/MultiMachineCoordinator.ts:203-204`); the
  `leasePullContested` latch (`:208`) was added to patch exactly the contested
  half of that blindness.
- The stale count is not cosmetic: `splitBrainState` derives from it
  (`awakeMachineCount > 1 || leasePullContested` ⇒ `'contested'`,
  `src/core/MultiMachineCoordinator.ts:977-981`), and it is served on
  `/health.multiMachine.syncStatus` (`src/server/routes.ts:2579-2581`) and
  `GET /pool`'s `router` block (`src/server/routes.ts:13564-13580`).

## 3. Design — detection rides the existing heartbeat machinery

**No new channel.** Verified transport inventory: every machine already (a)
records a rich SELF beat every 30s (`refreshPool`,
`src/commands/server.ts:17180-17251`), and (b) pulls every reachable peer's
self-capacity every 30s over the signed `session-status` mesh read
(`PeerPresencePuller.pullOnce`, scheduled at `src/commands/server.ts:20172`),
recording it into `MachinePoolRegistry` with field carry-forward semantics
(`src/core/MachinePoolRegistry.ts:229-267`). The guard adds ONE bounded field to
that existing envelope and ONE pure evaluator over the already-assembled pool
view. "One heartbeat cycle" in the roadmap's live-proof clause maps to one 30s
presence-pull tick.

### 3.1 The coherence-critical manifest (what is compared)

A fleet-uniform, code-shipped manifest — `COHERENCE_CRITICAL_FLAGS` in
`src/core/machineCoherenceManifest.ts` (the `GUARD_MANIFEST` /
`DEV_GATED_FEATURES` pattern: the manifest ships atomic with the code, so every
machine on version V evaluates the same set). Each entry:

```ts
interface CoherenceCriticalFlag {
  /** Stable key, e.g. 'seamlessness.ws13PinReplicate'. */
  key: string;
  /** Dotted config path. */
  configPath: string;
  /** How the effective value is computed: 'raw' | 'dev-gate' | 'dev-gate+dryRun'. */
  resolution: 'raw' | 'dev-gate' | 'dev-gate+dryRun';
  /** One line: the cross-machine guarantee a mixed pool halves (goes in the alarm body). */
  guarantee: string;
}
```

Initial membership (the flags whose SEMANTICS require pool agreement, chosen
from the verified config surface — final list is a convergence-review decision,
§10 Q1):

| key | resolution | guarantee halved when mixed |
|---|---|---|
| `seamlessness.ws13PinReplicate` + `ws13Reconcile` (+ dryRun) | dev-gate+dryRun | cross-machine NL move actuation (the F4 pair) |
| `seamlessness.ws43JournalLease` (+ dryRun) | dev-gate+dryRun | job-claim single-ownership (its own cutover gate already refuses mixed pools — `src/commands/server.ts:17070-17082` — the guard makes the withheld cutover VISIBLE instead of a dim boot log) |
| `seamlessness.ws44PoolLinks`, `ws44PoolCache` | dev-gate | cross-machine link serving / pool-cache honesty |
| `stateSync.<store>.enabled` (+ dryRun), per registered store | dev-gate (via `resolveStateSyncStores`, `src/core/devAgentGate.ts:69-84`) | replicated-memory reach (a non-advertising peer silently drops the kind) |
| `pollFollowsLease.enabled` (+ dryRun) | raw | ingress-follows-lease (the July-1 silent-loss shape) |
| `sessionPool.stage` | raw | whether the pool routes real traffic at all + the `exactlyOnceIngress` default it drives (`src/core/seamlessnessConfig.ts:126-128`) |
| `exactlyOnceIngress` (resolved) | raw (post-resolution) | per-message dedup ledger on every machine |
| `meshTransport.enabled` | raw | multi-rope reachability |
| `developmentAgent` | raw | the ROOT of the F4 class — every omitted-flag resolution flips with it |

Effective values are serialized as compact strings: `'live'`, `'dry-run'`,
`'off'`, or a clamped scalar (`'live-transfer'`). **Bounds (heartbeat-bloat +
content-scrub):** ≤ 64 entries, key ≤ 64 chars, value ≤ 32 chars, whole block
≤ 2 KB serialized; values come only from the local manifest's resolvers — never
free text, never secrets, never paths.

**Comparison is manifest-intersection.** Machines on different versions may
carry different manifests; a key present on one side only is NOT flag skew (it
is version skew, already alarmed by the version dimension). The advert carries
`manifestHash` (sha256 of the sorted key list) so the evaluator knows when it
is comparing across manifest generations.

### 3.2 The advert block and its transport

One new optional field on the capacity heartbeat, sibling to
`seamlessnessFlags`:

```ts
coherenceAdvert?: {
  instarVersion: string;        // ProcessIntegrity.runningVersion — executing code, not disk
  protocolVersion: number;      // SEAMLESSNESS_PROTOCOL_VERSION (src/core/seamlessnessConfig.ts:28)
  manifestHash: string;
  flags: Record<string, string>; // manifest-resolved effective values, clamped
}
```

- **Self beat:** built inside `refreshPool` next to the existing
  `seamlessnessFlags` construction (`src/commands/server.ts:17203`), recomputed
  each beat (a config-flip-plus-restart re-advertises within one beat).
- **Peer pull:** added to `PeerCapacity` AND to `SESSION_STATUS_ADVERT_FIELDS`
  (`src/core/PeerPresencePuller.ts:101-109`) so the existing wiring-integrity
  ratchet — built precisely because four prior advert fields were silently
  dropped by the receive-side narrowing — covers it from day one.
- **Carry-forward:** `MachinePoolRegistry.recordHeartbeat` gives it the SAME
  field-specific carry-forward as `seamlessnessFlags`/`posture`
  (`src/core/MachinePoolRegistry.ts:239-255`): a sparse liveness echo must not
  erase a peer's last advert; a fully-dark peer still ages out via
  `routerReceivedAtMs → online:false`.
- **Receive-side clamp:** a peer's advert is untrusted data — type-clamped on
  receive (string lengths, entry count, numeric protocolVersion), keyed on the
  REGISTRY's machine identity (never the body's self-claimed id), exactly the
  posture-ingestion rule (`src/core/types.ts:2075-2078`).
- **Why not widen `seamlessnessFlags`:** its documented contract is
  "fixed-size booleans only — never an inventory" (`src/core/types.ts:2034`)
  and it has load-bearing capability-gating consumers (sender-side emission
  gates). A manifest-driven value map is a different contract; overloading the
  existing block risks its consumers. (§10 Q3 offers the counter-position.)

### 3.3 The evaluator (pure, tick-driven, fails toward silence)

`MachineCoherenceSentinel` (`src/monitoring/MachineCoherenceSentinel.ts`), a
pure-core + thin-wiring module in the `checkPoolFlagCoherence` shape:

- **Input:** `machinePoolRegistry.getCapacities()` (self + peers), self's own
  advert, the clock. Runs on the existing 30s `peerPresenceTick` (the
  mesh-coherence live check already piggybacks there —
  `src/commands/server.ts:20113-20129` — precedent for a signal-only rider).
  No new timer, no fan-out of its own.
- **Scope:** ONLINE machines only (`capacity.online`, derived from
  router-clock receipt freshness, `src/core/MachinePoolRegistry.ts:313-314`).
  An offline peer is a liveness problem with existing owners (rope health,
  pool view) — comparing against its last-known advert would alarm on ghosts.
  A peer that is online but has NO advert yet (older version / pre-advert
  boot) is reported as `unknown`, and `unknown` versus a known value is
  surfaced as **version-class skew** (the peer predates the guard), never as
  flag skew.
- **Dimensions + confirmation gates (each pins a number; §10 Q2):**
  - **Flag skew** — any manifest-intersection key whose effective values
    differ across online machines. Confirmed after `flagConfirmTicks`
    consecutive evaluator ticks seeing the same divergence (default **2**,
    the GuardPostureProbe persistence pattern —
    `src/monitoring/probes/GuardPostureProbe.ts:56-58`); worst-case alarm
    latency ≈ 60–90s. A flag flip requires a restart to take effect, so a
    confirmed divergence is state, not flap.
  - **Version skew** — `instarVersion` differs. Differing **major.minor**:
    confirmed like flag skew (2 ticks). Differing **patch only**: confirmed
    only after `versionSkewGraceMs` (default **45 min**) of continuous skew —
    a normal update wave rolls machines sequentially (the restart-cascade
    dampener alone batches up to 15 min), and alarming mid-wave would make
    every auto-update cry wolf.
  - **Protocol skew** — `protocolVersion` differs: confirmed like flag skew.
    The lease layer already treats a below-version machine as
    handoff-ineligible (`src/core/seamlessnessConfig.ts:16-27`); the guard
    makes the degradation visible.
- **Fail toward silence:** any evaluator error, an unreadable pool view, a
  clamp rejection → no emit this tick, an error counter on the status route
  (§6). A guard that can flood on its own malfunction re-creates the disease
  it treats.
- **Single-machine: strict no-op.** Zero online peers ⇒ empty comparison set ⇒
  the evaluator returns an empty verdict before any state is touched.

## 4. Alerting — one episode, one item, auto-resolve, bounded escalation

### 4.1 Episode semantics

An **episode** opens when the first skew is confirmed and closes when a full
evaluator pass over the same online peer set finds **zero** skew for
`resolveTicks` consecutive ticks (default **3**). Episode state is durable JSON
under `state/machine-coherence-episode.json` (atomic tmp+rename; a corrupt file
re-baselines without crashing — the GuardPostureProbe pattern), so a server
restart mid-episode neither re-alarms nor forgets.

### 4.2 The ONE attention item

- Raised via the existing chokepoint `telegramAdapter.createAttentionItem`,
  which is idempotent on item id (`src/messaging/TelegramAdapter.ts:3798-3802`)
  — the id is `machine-coherence:<episodeId>`, so re-raising within an episode
  is structurally a no-op.
- Priority **HIGH** — a halved cross-machine guarantee is operator-actionable.
  HIGH is never coalesced by the topic-flood guard
  (`src/messaging/TelegramAdapter.ts:3858-3864`), so the alarm always gets its
  own visible surface. (§10 Q4 offers the agent-health-lane counter-position.)
- Body: a compact table — one row per skew: dimension, key, per-machine
  effective values (by nickname), and the manifest entry's `guarantee` line —
  plus the exact fix lever ("set `multiMachine.seamlessness.ws13PinReplicate`
  explicitly on <nickname> (`PATCH /config`) and restart, or equalize
  `developmentAgent`"). The alarm names the one-tap fix; it never performs it.
- **New skew keys join the OPEN episode** (the item is updated in place + one
  short append on its topic), never a second item — per-flag items are the
  named anti-pattern this spec exists to avoid.

### 4.3 Auto-resolve marker

On episode close: the item is PATCHed `resolved` and ONE resolution note lands
on the same topic ("machine-coherence restored — <keys> now agree across
<nicknames>, held for <resolveTicks> ticks"). A later divergence is a NEW
episode (new id suffix, same stable source), so a recurrence is visible as a
recurrence.

### 4.4 Escalation only on persistence

If an episode stays open past `escalateAfterMs` (default **24 h**), exactly ONE
escalation append on the existing item's topic ("still divergent after 24h").
Then silence — bounded, level-triggered, P19. The episode latch is the
`FailureEpisodeLatch` shape (`src/core/FailureEpisodeLatch.ts:1-60`): signal
once per episode, stay quiet while the condition persists, reset on recovery.

## 5. The `awakeMachineCount` telemetry fix (named sub-item)

Two independent corrections, shipping as bug-fixes (live, not dev-gated — they
correct an existing lying surface; see §7 for the boundary):

**5a. Version telemetry actually populated.** `src/commands/server.ts:17094`
passes the running version:
`captureHardware(ProcessIntegrity.getInstance()?.runningVersion ?? config.version)`.
This retroactively activates the already-written consumer at
`src/server/routes.ts:6645/6671` (peer-version annotation on
`/guards?scope=pool` failure rows) and gives the registry a durable
version-per-machine record. The LIVE per-beat truth still comes from the §3.2
advert (the registry copy is boot-stale by design — hardware self-attest only
rewrites on change, `src/core/MachineIdentity.ts:443-448`).

**5b. `awakeMachineCount` derives from live lease state.** In
`getSyncStatus()` (`src/core/MultiMachineCoordinator.ts:966-1003`):

- **When a lease coordinator is attached** (the modern path): count = (self
  `holdsLease()` ? 1 : 0) + the number of ONLINE peers whose freshest
  lease-pull observation shows that peer naming ITSELF as holder. The pull
  loop already collects exactly this view (it is what latches
  `leasePullContested`, `:198-208`); the fix promotes it from a boolean latch
  to the count's source. Source tag: `'lease-live'`.
- **Legacy heartbeat mode** (no lease coordinator): keep the registry-role
  count, tagged `'registry-roles'` — with its staleness now named instead of
  implied.
- **Read failure is honest:** an unreadable underlying source yields
  `awakeMachineCount: null` + source `'unavailable'` — never a silent 0
  (today's `:973` catch). `splitBrainState` keeps its semantics
  (`contested` iff live count > 1 or `leasePullContested`); with a null count
  it degrades to the latch alone.
- **Surface shape:** `MultiMachineSyncStatus.awakeMachineCount` becomes
  `number | null` and gains a sibling `awakeMachineCountSource:
  'lease-live' | 'registry-roles' | 'unavailable'`
  (`src/core/MultiMachineCoordinator.ts:41-85`). Serializers touched:
  `/health` (`src/server/routes.ts:2579-2581`), `GET /pool` router block
  (`:13564-13580`), and the two other `getSyncStatus()` route callers
  (`:13713`, `:13907`). Consumer-compat is §10 Q5.

The invariant this declares (Cross-Store Coherence Is an Invariant): *the
machine registry's role rows and the live lease/pull view answer the same
question; where they disagree, the live view wins and the surface says which
source spoke.*

## 6. Observability

- **Status route:** `GET /pool/machine-coherence` (Bearer-authed; **503 when
  the guard is dark on this agent** — the standard dark-route posture) →
  `{ enabled, dryRun, lastTickAt, machinesCompared, openEpisode:
  { episodeId, openedAt, skews: [...] } | null, counters: { ticks, skewsConfirmed,
  wouldRaise, raised, resolved, escalated, errors } }`. Registry First: "are my
  machines coherent?" is a read, never a guess.
- **Audit log:** `logs/machine-coherence.jsonl` — one row per state
  TRANSITION (skew confirmed / episode open / key joined / episode closed /
  escalated / error-class change), never per-tick rows (the transition-only
  rule the mesh-coherence live check already follows).
- **Guard inventory:** the sentinel registers in `GUARD_MANIFEST`
  (`src/monitoring/guardManifest.ts`) so `GET /guards` grades its posture like
  every other guard — a coherence guard that silently turned off must itself
  be a visible anomaly. Not marked load-bearing in v1 (§10 Q6).
- **Boot line:** one dim line naming resolved posture
  (`enabled/dryRun/manifestHash/flagCount`).

## 7. Config & rollout (graduated, dark on the fleet)

```jsonc
// .instar/config.json
"monitoring": {
  "machineCoherence": {
    // "enabled" DELIBERATELY OMITTED from ConfigDefaults — resolveDevAgentGate
    // decides (LIVE on a development agent, DARK on the fleet). An explicit
    // value always wins. (#1001 anti-mechanism.)
    "dryRun": true,               // dry-run FIRST even on dev: evaluator runs,
                                  // jsonl + counters record would-raise; NO item.
    "flagConfirmTicks": 2,
    "versionSkewGraceMs": 2700000, // 45 min
    "resolveTicks": 3,
    "escalateAfterMs": 86400000    // 24 h
  }
}
```

- Registered in `DEV_GATED_FEATURES` (`src/core/devGatedFeatures.ts:45`) so the
  both-sides wiring test proves live-on-dev / dark-on-fleet resolution.
  Justification line: signal-only — raises at most one attention item per
  episode; no spend, no egress beyond the existing signed mesh reads, no
  destructive action; dry-run canary holds all sends.
- Graduation ladder: dark fleet → dev dry-run soak (named criterion: ≥ 5 days
  of dry-run rows on the live dev pair with zero false-positive would-raises;
  a deliberate injected skew correctly detected) → dev live
  (`dryRun:false`) → fleet flip. The §9 acceptance battery runs at the
  dev-live rung.
- **Boundary with §5:** the bug-fixes (5a/5b) ship live for everyone —
  correcting a false telemetry reading is not a new behavior and must not wait
  on a dev-gate. The SENTINEL (advert + evaluator + alarm) is the dev-gated
  dark feature. The advert field itself ships with the sentinel's code but is
  emission-harmless (a bounded self-describing block; peers without the code
  ignore unknown fields — same additive-advert path every prior field took).
- Migration parity: config defaults are additive under `migrateConfig()`
  existence checks; the CLAUDE.md template gains the status-route + "why did I
  get a machine-coherence alarm?" proactive triggers (Agent Awareness
  standard, `src/scaffold/templates.ts`).
- Single-machine agents: strict no-op at every layer (no peers → empty
  comparison → no state, no item; the status route reports
  `machinesCompared: 1`).

## 8. Phase 2 — updater coordination (fleet version owner)

Explicitly **not in this build**; recorded here so the roadmap item's third
clause has a design anchor and the reviewers can sanity-check that nothing in
this build forecloses it.
<!-- tracked: roadmap-2026-07/phase-4.1-updater-coordination -->

Sketch (to be spec-converged separately when picked up
<!-- tracked: roadmap-2026-07/phase-4.1-updater-coordination -->):

- The serving-lease holder (or the F4 preferred captain) acts as **version
  owner**: when the auto-updater lands version V on it, it (a) announces V as
  the pool target, (b) watches peers' §3.2 adverts converge to V, (c) raises
  the §4 alarm through the SAME episode machinery if a peer stalls below V past
  a bound — no second alerting surface.
- Sequencing rule (standby-first): peers update and restart first, verified by
  their advert flipping to V; the owner updates last at a clean lease boundary
  — so the pool never has ZERO machines on the working version, and the
  update wave never kills the serving machine while a peer is mid-restart.
- Builds strictly ON this spec's plumbing: the advert IS the verification
  channel; the guard IS the alarm; what Phase 2 adds is the coordination actor
  and its authority story (an updater that restarts peer machines is
  action-bearing and needs its own mandate/consent analysis — precisely why it
  is not smuggled into this signal-only build).

## 9. Testing plan (Testing Integrity Standard — all three tiers)

**Tier 1 — unit (`tests/unit/`):**
- Manifest resolution: each `resolution` mode against dev-agent and fleet
  configs; the F4 case reproduced (both configs omit the flag,
  `developmentAgent` differs → effective values differ).
- Evaluator semantics, both sides of every boundary: no-skew pool → empty
  verdict; single flag divergence → confirmed only at `flagConfirmTicks`;
  patch-only version skew inside vs past `versionSkewGraceMs`; major.minor
  skew immediate; manifest-hash mismatch → version-class, never flag-class;
  offline peer excluded; advert-less online peer → `unknown`/version-class;
  clamp rejection → error counter, no emit.
- Episode latch: open → key joins → close at `resolveTicks` → recurrence is a
  NEW episode; escalation fires exactly once; durable state survives
  reload; corrupt state file re-baselines.
- `awakeMachineCount` derivation: lease-live counting (self holder only /
  peer-self-claims / dual-claim ⇒ 2 + contested), legacy registry mode,
  unreadable source ⇒ `null` + `'unavailable'` (NOT 0).
- `captureHardware(version)` stamps `hardware.instarVersion`.

**Tier 2 — integration (`tests/integration/`):**
- `GET /pool/machine-coherence`: 503 when dark; 200 with live counters when
  enabled; dry-run reports `wouldRaise` without an item.
- Injected skewed heartbeats across ≥ `flagConfirmTicks` ticks → exactly ONE
  attention item exists (id-stable across further ticks); skew cleared →
  item resolved + one resolution note; a second divergence → second episode.
- `/health` + `GET /pool` serve the new count shape; registry-unreadable
  fixture serves `null`/`'unavailable'`.
- Advert pass-through ratchet: `SESSION_STATUS_ADVERT_FIELDS` includes
  `coherenceAdvert` (the existing ratchet test auto-covers the narrowing).
- Wiring integrity: the sentinel's deps (registry, attention emitter, clock)
  are real, non-null, delegating — per the DI standard.

**Tier 3 — E2E lifecycle (`tests/e2e/`):**
- The Phase-1 "feature is alive" test: production init path with a
  dev-agent config → status route 200, evaluator ticking; fleet config →
  503; single-machine config → alive but `machinesCompared: 1`, zero
  episodes ever.

**Acceptance battery — the roadmap live-proof clause, restated:**
1. *"Deliberately skew a flag on one machine → alarm within one heartbeat
   cycle."* On the live dev pair (dev-live rung): flip one manifest flag
   explicitly on one machine + restart it → ONE HIGH attention item naming
   the key, both nicknames, and the guarantee, within
   `flagConfirmTicks × 30s` of the machine's first post-restart beat (≤ 60s
   at defaults — within one cycle at `flagConfirmTicks:1`, within two at the
   shipped default; the reviewers pin the default against the clause, §10 Q2).
   Un-skew → the same item auto-resolves with the marker. Zero further
   messages in between (the one-item property observed, not assumed).
2. *"Matrix transfer scenario passes with zero manual config surgery."* Re-run
   the S3/S5 cross-machine NL-move scenario from the 2026-07-02 matrix on a
   coherent pair: the guard is SILENT throughout (no false positive), and the
   transfer actuates without any hand-edit of either machine's config. Then
   re-introduce the F4 asymmetry: the guard names it BEFORE the move is
   attempted — the operator-visible difference between "silent pending
   forever" and "one alarm naming the one-line fix". (Honest scope: this
   build detects and names; it does not equalize configs — auto-equalization
   is Phase 2's authority question.
   <!-- tracked: roadmap-2026-07/phase-4.1-updater-coordination -->)
3. `awakeMachineCount` live probe: on the healthy pair, `/health` reports
   `1` + `'lease-live'` (never 0) with the Mini holding the lease; killing
   the holder and forcing failover never yields a silent 0 during the
   transition.

## 10. Open questions for the convergence reviewers

1. **Manifest membership + comparison basis.** Is comparing RESOLVED effective
   values (post dev-gate, dry-run folded) the right basis — meaning a
   `developmentAgent` asymmetry inside one agent's pool is ALWAYS alarmed
   (the F4 position this draft takes)? Or is there a legitimate mixed-dev
   pool topology that needs a per-key suppression list? And: is the §3.1
   initial flag list right — anything missing (topicProfiles?
   `subscriptionPool` posture?) or over-included (`meshTransport.enabled`,
   which a single-rope pool legitimately varies)?
2. **Confirmation defaults vs the roadmap clause.** `flagConfirmTicks: 2`
   (≤ 60–90s alarm) follows the GuardPostureProbe persistence pattern but is
   strictly "within TWO 30s beats", while the roadmap clause says "within one
   heartbeat cycle". Ship 1 (meets the clause literally, slightly flappier) or
   2 (house pattern, marginally slower)? Same question for
   `versionSkewGraceMs: 45min`.
3. **Advert placement.** New `coherenceAdvert` block (this draft) vs widening
   the existing `seamlessnessFlags` map — one block fewer on the wire, but it
   overloads a bounded contract with load-bearing emission-gate consumers.
4. **Alarm surface.** Plain HIGH attention item with its own topic (this
   draft) vs the agent-health lane (calmer, but the lane exists for
   housekeeping and this is an operator-actionable config decision).
5. **`awakeMachineCount` shape change.** `number | null` + source tag is the
   honest shape; are there external consumers (dashboards, `instar doctor`,
   fleet tooling) that would break on `null`, and do we owe a compat shim
   (keep `0` + add the source tag) instead?
6. **Guard posture weight.** Should the sentinel be marked `loadBearing` in
   the guard manifest (its absence silently un-guards the coherence of every
   OTHER dev-gated mesh feature — arguably the definition of load-bearing) or
   is that circular for a signal-only feature in v1?
7. **Dry-run soak length.** Is the ≥ 5-day zero-false-positive criterion the
   right graduation bar for the dev pair, given update waves (which SHOULD
   produce grace-window-suppressed version skew rows, not would-raises)?

## 11. Verified code-grounding index

Every citation checked in this worktree (branch `echo/machine-coherence-guard`
at v1.3.728):

| Fact | Where |
|---|---|
| `awakeMachineCount` counts local-registry `role === 'awake'` rows; silent 0 on read failure; feeds `splitBrainState` | `src/core/MultiMachineCoordinator.ts:966-1003` (count `:967-973`, catch `:973`, splitBrain `:977-981`) |
| In-code admission the registry count misses a git-less mesh | `src/core/MultiMachineCoordinator.ts:198-208` |
| Role rows written only on self transitions | `src/core/MultiMachineCoordinator.ts:1182-1189` |
| Registry merge: later-`lastSeen` entry wins whole-row | `src/core/mergeRegistry.ts:37-53`; conflict hook `src/core/GitSync.ts:1054-1065` |
| `lastSeen` refreshed by non-role writers | `src/core/MachineIdentity.ts:380` (register), `:412` (nickname) |
| `hardware.instarVersion` exists but the only callsite omits it | type `src/core/types.ts:1951`; `captureHardware` `src/core/MachinePoolRegistry.ts:27-38`; callsite `src/commands/server.ts:17094` |
| A consumer already reads the never-populated peer version | `src/server/routes.ts:6645`, `:6671` |
| Truthful own-version source | `src/core/ProcessIntegrity.ts:92`; used at `src/server/routes.ts:6617` |
| Rich self-beat built + 30s cadence | `src/commands/server.ts:17180-17222` (flags `:17203`), interval `:17251` |
| Peer presence pull + 30s cadence + advert-field ratchet | `src/core/PeerPresencePuller.ts:101-150`; scheduled `src/commands/server.ts:20172` |
| Heartbeat field carry-forward pattern | `src/core/MachinePoolRegistry.ts:229-267` |
| `seamlessnessFlags` contract ("fixed-size booleans, never an inventory") | `src/core/types.ts:2027-2074` |
| Existing comparator is stateSync-only, boot-log-only | `src/core/ReplicatedRecordEnvelope.ts:665-700`; wiring `src/commands/server.ts:17254-17289` |
| ws43 cutover already refuses incoherent pools (quietly) | `src/commands/server.ts:17070-17090` |
| Dev-gate resolution + feature registry | `src/core/devAgentGate.ts:44-47`, `:69-84`; `src/core/devGatedFeatures.ts:45` |
| `exactlyOnceIngress` default derives from `sessionPool.stage` | `src/core/seamlessnessConfig.ts:126-128`; protocol version `:28` |
| Attention item id-idempotent create; HIGH never coalesced | `src/messaging/TelegramAdapter.ts:3798-3802`, `:3858-3864` |
| Episode-latch + persistence-ticks house patterns | `src/core/FailureEpisodeLatch.ts:1-60`; `src/monitoring/probes/GuardPostureProbe.ts:56-70` |
| syncStatus served on `/health` and `/pool` | `src/server/routes.ts:2579-2581`, `:13564-13580` (also `:13713`, `:13907`) |
| multiMachine config surface (pollFollowsLease / meshTransport / sessionPool / stateSync / seamlessness) | `src/core/types.ts:2274-2561` (`:2388`, `:2408`, `:2352`, `:2446`, `:2454-2560`) |
