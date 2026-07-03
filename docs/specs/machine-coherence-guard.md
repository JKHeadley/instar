---
slug: machine-coherence-guard
title: Agent Machine-Coherence Guard — pool-wide version + flag-skew detection, one alarm (Roadmap 4.1, F4/P0-1)
status: draft — round-2 revision (round-1 findings folded; awaiting round-2 convergence review)
author: echo
eli16-overview: machine-coherence-guard.eli16.md
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
constitution: Cross-Store Coherence Is an Invariant (machine-registry roles vs live lease/heartbeats answer the same "who is awake" question with no declared agreement check — this spec declares and mechanizes it); A Dark Feature Guards Nothing (the F4 audit named this pattern verbatim — G3 covers guards, nothing covers seamlessness flags); Bounded Notification Surface (ONE episode-scoped attention item, never per-heartbeat or per-flag — and §4 names its OWN brakes normatively, because the universal topic budget does NOT cover this path); Structure beats Willpower ("both machines manually equalized" is willpower; the guard is structure); Agent Proposes, Operator Approves (the §4.2 alarm proposes a fix the agent performs on approval — it never walks the operator into config surgery)
lessons-engaged: "P17 (ONE deduped attention item per skew episode — §4); P19 (episode latch + bounded escalation + recurrence damper + per-day cap that gives up loudly — §4.3, §4.4, §4.5); F4 finding family (dev-gate asymmetry silently halves a cross-machine guarantee with no alarm — §1); P0-1 (fleet version coherence has no owner — §1, §8); Verify the State, Not Its Symbol (awakeMachineCount must derive from live lease observations, not last-written registry role rows — §5; and the guard's own comparison universe is flagged when it shrinks — §3.3); the #930/A2/WS2.1/seamlessnessFlags narrowing-return class (the new advert field joins the SESSION_STATUS_ADVERT_FIELDS ratchet so the receive path cannot silently drop it — §3.2); the seamlessnessFlags/posture carry-forward pattern (a sparse liveness beat must not erase a peer's last advert — §3.2, now with an explicit staleness bound so carry-forward can never impersonate freshness); #1001 anti-mechanism (enabled OMITTED from shipped config, resolved via resolveDevAgentGate; registered in DEV_GATED_FEATURES — §7); the 2026-06-05 partial-config-PATCH clobber hazard (the agent-performed fix writes FULL config blocks, never a partial nested PATCH — §4.2)"
earned-from: "2026-07-02 live test-as-self matrix, finding F4 (docs/audits/test-as-self-matrix-2026-07.md, echo agent home): the same agent's two machines resolved ws13PinReplicate differently (Laptop developmentAgent:true → LIVE; Mini config lacked it → DARK), so an NL cross-machine move was acked to the user and then silently never actuated — pinState:pending forever, no alarm. Repaired in-session by hand-editing the Mini's config; the CLASS stayed open. Same audit: awakeMachineCount:0 on /health while both machines were online and the Mini held the lease (P0-1 telemetry incoherence, reproduced live on v1.3.722)."
roadmap: "instar-two-goal-roadmap-2026-07 §5 Phase 4 item 4.1 — 'Agent machine-coherence guard: pool-wide version + seamlessness-flag skew detection → ONE attention item; fix awakeMachineCount telemetry; then updater coordination (fleet version owner)'. Live proof: 'Deliberately skew a flag on one machine → alarm within one heartbeat cycle; matrix transfer scenario passes with zero manual config surgery.' Honesty note (Frontloaded Decision D2): at the shipped default flagConfirmTicks:2 the acceptance clause is restated as '≤ 2 presence-pull cycles (≤ 90s)'."
---

# Agent Machine-Coherence Guard (roadmap 4.1) — round-2 revision

One new sentinel, one telemetry bug-fix, one honestly-scoped later phase:

1. **The machine-coherence guard** (the build): a manifest-driven skew detector
   that compares, across every ONLINE machine in the pool, (a) the running
   instar version, (b) the resolved values of the coherence-critical
   multi-machine flags, (c) the mesh protocol version, and (d) the manifest
   generation itself — riding the EXISTING 30s capacity-heartbeat/presence-pull
   machinery, and raising **ONE deduped, episode-scoped attention item, from
   exactly ONE elected machine** (§3.4), when the pool diverges. Signal-only;
   it never blocks, equalizes, or restarts anything.
2. **The `awakeMachineCount` telemetry fix** (a bug-fix riding along, §5): the
   count published on `/health` and `GET /pool` derives from stale per-machine
   registry role rows and silently reads 0 on a read failure; it moves to a NEW
   per-peer lease-observation view (§5b names the new retained state honestly —
   the current code keeps only a single most-recent observation slot) with an
   explicit source tag.
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
- **(b) The alarm is one item, not a stream — POOL-WIDE, not per-machine.**
  Never per-heartbeat, never per-flag, and never one-per-evaluating-machine:
  a deterministic **raiser election** (§3.4) means exactly one machine owns the
  attention surface for an episode; every other machine evaluates and records
  locally but raises nothing. One episode-scoped attention item aggregates
  every currently-open skew, is updated in place, auto-resolves with a marker
  when the pool converges (and ONLY then claims restoration — a peer going
  offline suspends, it never fakes "restored", §4.3), and escalates at most
  once on persistence. (The Telegram-noise constitution rule: agent acts, user
  gets ONE consolidated alert.)

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

Every citation below was verified in this worktree at v1.3.728 (re-verified in
the round-2 revision pass).

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
  `GET /pool`'s `router` block (`src/server/routes.ts:13564-13580`). Three
  in-code consumers GATE behavior on `splitBrainState`: the ingress step-down
  suppression (`src/commands/server.ts:4959` — unreadable status reads as
  split-brain-active, the safe direction), the WS3 speaker-election
  `leaseStable` input (`:12383`), and the rope-health monitor's
  `splitBrainItemOpen` one-episode-one-ask gate (`:20604`). §5b's redesign
  preserves `splitBrainState`'s derivation semantics so all three keep their
  current behavior.

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
presence-pull tick (see the frontmatter honesty note and Frontloaded Decision
D2: the shipped default is confirmation across TWO cycles).

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
  /**
   * Where the entry's REAL consumer reads it from (M8): 'boot' = the boot-time
   * config object (a change requires restart to take effect) | 'live' =
   * liveConfig (a PATCH /config changes behavior with NO restart — e.g.
   * sessionPool.stage is read via liveConfig.get at
   * src/commands/server.ts:20177-20186). The resolver MUST read each entry the
   * way its real consumer does, or the advert lies about effective behavior.
   */
  readSource: 'boot' | 'live';
  /** One line: the cross-machine guarantee a mixed pool halves (goes in the alarm body). */
  guarantee: string;
}
```

Membership (Frontloaded Decision D1 — comparison basis is RESOLVED effective
values; a `developmentAgent` asymmetry inside one agent's pool is ALWAYS
alarmed; mixed-dev pools are not a supported topology):

| key | resolution | readSource | guarantee halved when mixed |
|---|---|---|---|
| `seamlessness.ws13PinReplicate` + `ws13Reconcile` (+ dryRun) | dev-gate+dryRun | boot | cross-machine NL move actuation (the F4 pair) |
| `seamlessness.ws43JournalLease` (+ dryRun) | dev-gate+dryRun | boot | job-claim single-ownership (its own cutover gate already refuses mixed pools — `src/commands/server.ts:17070-17082` — the guard makes the withheld cutover VISIBLE instead of a dim boot log) |
| `seamlessness.ws44PoolLinks`, `ws44PoolCache` | dev-gate | boot | cross-machine link serving / pool-cache honesty |
| `stateSync.<store>.enabled` (+ dryRun), per registered store | dev-gate (via `resolveStateSyncStores`, `src/core/devAgentGate.ts:69-84`) | boot | replicated-memory reach (a non-advertising peer silently drops the kind) |
| `pollFollowsLease.enabled` (+ dryRun) | raw | boot | ingress-follows-lease (the July-1 silent-loss shape) |
| `sessionPool.stage` | raw | **live** | whether the pool routes real traffic at all + the `exactlyOnceIngress` default it drives (`src/core/seamlessnessConfig.ts:126-128`) |
| `exactlyOnceIngress` (resolved) | raw (post-resolution) | live (rides `sessionPool.stage`) | per-message dedup ledger on every machine |
| `meshTransport.enabled` | raw | boot | multi-rope reachability |
| `developmentAgent` | raw | boot | the ROOT of the F4 class — every omitted-flag resolution flips with it |
| `monitoring.machineCoherence` (self-posture: `live`/`dry-run`/`dark`) | dev-gate+dryRun | boot | the guard ITSELF (N2): a pool where one side evaluates and the other doesn't has silently halved alarm redundancy — and under §3.4's election, an asymmetric guard posture changes who may raise |

Effective values are serialized as compact strings: `'live'`, `'dry-run'`,
`'off'`, or a clamped scalar (`'live-transfer'`). **Bounds (heartbeat-bloat +
content-scrub):** ≤ 64 entries, key ≤ 64 chars, value ≤ 32 chars, whole block
≤ 2 KB serialized; values come only from the local manifest's resolvers — never
free text, never secrets, never paths.

**Manifest maintenance guards (N5):**
- A build-time **manifest-size ratchet test** fails the build if the manifest
  exceeds 64 entries or the serialized reference advert exceeds 2 KB — organic
  growth can never silently push every machine's advert into clamp-rejection
  (which would kill the guard pool-wide).
- A **membership drift guard**: a unit test cross-references every
  `DEV_GATED_FEATURES` entry whose `configPath` starts with `multiMachine.`
  against the manifest plus an explicit in-code exclusion list (each exclusion
  carrying a one-line reason). Adding a new coherence-relevant dev-gated flag
  without making a manifest decision fails the build — the F4 class cannot be
  silently re-created for future flags.

**Comparison is manifest-intersection.** Machines on different versions may
carry different manifests; a key present on one side only is NOT flag skew (it
is version skew, already alarmed by the version dimension). The advert carries
`manifestHash` — sha256 over the sorted **entries** (key + resolution mode +
readSource), not just the key list (M7: two builds can share keys but differ in
resolution semantics) — so the evaluator knows when it is comparing across
manifest generations. `manifestHash` mismatch with IDENTICAL `instarVersion`
is its own confirmed skew dimension (**manifest-class**, §3.3) — the
dirty/locally-built-dist case a version compare cannot see.

### 3.2 The advert block and its transport

One new optional field on the capacity heartbeat, sibling to
`seamlessnessFlags`:

```ts
coherenceAdvert?: {
  instarVersion: string;        // ProcessIntegrity.runningVersion — executing code, not disk
  protocolVersion: number;      // SEAMLESSNESS_PROTOCOL_VERSION (src/core/seamlessnessConfig.ts:28)
  manifestHash: string;         // sha256 over sorted entries (key+resolution+readSource)
  guard: 'live' | 'dry-run' | 'dark'; // the guard's OWN resolved posture on this machine (N2; feeds §3.4 election)
  beatSeq: number;              // sender-side monotonic advert generation (M5)
  flags: Record<string, string>; // manifest-resolved effective values, clamped
}
```

- **Emission is UNCONDITIONAL (normative — M3).** The advert ships live with
  the code and is emitted on EVERY machine running a version that carries it,
  regardless of the sentinel's dev-gate, `enabled`, or `dryRun` state. Only the
  EVALUATOR + alarm are dev-gated (§7). Rationale, pinned against the founding
  incident: if emission rode the sentinel's gate, the exact F4 pair (Laptop dev
  → live, Mini fleet → dark) would leave the Mini advert-less and the Laptop
  would misclassify the incident as "version-class skew — the peer predates the
  guard" — a false diagnosis of the very incident this spec exists to name, and
  a standing false-positive poisoning the §7 soak criterion by construction. A
  unit test asserts an advert is built from a fleet (non-dev, no
  `machineCoherence` config) configuration. The advert is emission-harmless: a
  bounded self-describing block; peers without the code ignore unknown fields
  (the same additive-advert path every prior field took).
- **Self beat:** built inside `refreshPool` next to the existing
  `seamlessnessFlags` construction (`src/commands/server.ts:17203`), recomputed
  each beat with `beatSeq` incremented — a boot-read entry re-advertises within
  one beat of the restart that applied it; a live-read entry (`readSource:
  'live'`, M8) re-advertises within one beat of the `PATCH /config`, no restart
  involved.
- **Peer pull:** added to `PeerCapacity` AND to `SESSION_STATUS_ADVERT_FIELDS`
  (`src/core/PeerPresencePuller.ts:101-109`) so the existing wiring-integrity
  ratchet — built precisely because four prior advert fields were silently
  dropped by the receive-side narrowing — covers it from day one.
- **Carry-forward + staleness (M5):** `MachinePoolRegistry.recordHeartbeat`
  gives it the SAME field-specific carry-forward as `seamlessnessFlags`/
  `posture` (`src/core/MachinePoolRegistry.ts:239-255`): a sparse liveness echo
  must not erase a peer's last advert. BUT carry-forward must never impersonate
  freshness: the registry stamps `advertReceivedAtMs` when (and only when) a
  beat actually CARRIES a `coherenceAdvert`, and the evaluator degrades any
  advert older than `advertStaleMs` (default **5 min** = 10 pull cycles) to
  **`advert-stale`** — treated like `unknown` (version-class surfacing after
  grace, §3.3), never compared as current truth. This closes the real gap:
  coarse git-synced heartbeats refresh `routerReceivedAtMs` liveness WITHOUT
  carrying an advert (`src/commands/server.ts:17225-17236`;
  `src/core/MachinePoolRegistry.ts:212-227`), so a peer whose HTTP
  `session-status` path is down while git sync flows would otherwise stay
  "online" with a frozen advert read as current.
- **Receive-side clamp — NEW BUILD WORK (M4).** No receive-side clamp exists
  today: `narrowSessionStatusToPeerCapacity`
  (`src/core/PeerPresencePuller.ts:122-150`) and
  `MachinePoolRegistry.recordHeartbeat` (`src/core/MachinePoolRegistry.ts:209-278`)
  store peer objects verbatim; the cited posture-ingestion doc comment
  (`src/core/types.ts:2075-2078`) documents identity-binding + receipt-age
  only. This spec DELIVERS the clamp, in the puller's narrowing step:
  type-clamp on receive (string lengths per §3.1 bounds, entry count ≤ 64,
  numeric `protocolVersion`/`beatSeq`, whole block ≤ 2 KB), keyed on the
  REGISTRY's machine identity (never the body's self-claimed id — the same
  identity rule the puller already enforces at
  `src/core/PeerPresencePuller.ts:243-254`).
  **Rejection semantics (both failure directions closed):** a clamp-REJECTED
  advert is stored as an explicit rejection marker
  (`coherenceAdvertRejected: { atMs, reason }`) that (i) REPLACES the peer's
  stored advert for evaluation purposes — the last good advert is retained for
  forensics but is NEVER carried forward as the peer's current posture (a
  malformed sender cannot sit permanently misrepresented as coherent), and
  (ii) classifies the peer **`advert-rejected`** — surfaced through the SAME
  confirmation path as version-class skew, so persistent malformation is a
  LOUD named condition ("machine X's coherence advert is malformed — cannot
  verify coherence"), never permanent silence. Rejected ≠ absent, by
  construction. An error counter on the status route increments per rejection.
- **Why not widen `seamlessnessFlags`** (Frontloaded Decision D3): it has
  load-bearing capability-gating consumers (sender-side emission gates) — the
  decisive half of the argument. (Its documented "fixed-size booleans only —
  never an inventory" contract at `src/core/types.ts:2034` is the weaker half:
  already precedent-eroded by `stateSyncReceive?: Record<string, boolean>`
  living inside it, `src/core/types.ts:2062-2074`.) A manifest-driven value
  map is a different contract; overloading the existing block risks its
  consumers.

### 3.3 The evaluator (pure, tick-driven, fails toward silence)

`MachineCoherenceSentinel` (`src/monitoring/MachineCoherenceSentinel.ts`), a
pure-core + thin-wiring module in the `checkPoolFlagCoherence` shape:

- **Input:** `machinePoolRegistry.getCapacities()` (self + peers), self's own
  advert, the clock. Runs on the existing 30s `peerPresenceTick` (the
  mesh-coherence live check already piggybacks there —
  `src/commands/server.ts:20113-20129` — precedent for a signal-only rider).
  No new timer, no fan-out of its own.
- **Comparison-universe honesty (M11):** the machine list comes from the
  machine-registry listing (`src/core/MachinePoolRegistry.ts:298-300`) — the
  same store whose staleness pathologies §2.4 documents. The evaluator
  therefore records BOTH `machinesRegisteredOnline` (registry rows currently
  online) and `machinesCompared` (rows that actually entered the comparison),
  and any peer that is registered-online but missing/unreadable from the
  comparison set is classified **`unknown`** — surfaced, never silently
  treated as coherent. A shrunken universe is a visible condition on the
  status route (§6), not a quiet smaller denominator.
- **Scope:** ONLINE machines only (`capacity.online`, derived from
  router-clock receipt freshness, `src/core/MachinePoolRegistry.ts:313-314`).
  An offline peer is a liveness problem with existing owners (rope health,
  pool view) — comparing against its last-known advert would alarm on ghosts.
  (What happens when a peer that PARTICIPATES in an open episode goes offline
  is an episode-lifecycle question — §4.3's suspension semantics, M1.)
- **Peer classification** (each class has pinned handling):
  - **`compared`** — online, fresh clamp-passed advert: enters all dimensions.
  - **`unknown`** — online but NO advert (older version / pre-advert boot /
    missing from comparison set): surfaced as **version-class** skew ("the
    peer predates the guard"), confirmed only after `versionSkewGraceMs`
    (M3 — an advert-less peer is mid-update-wave until proven otherwise;
    a ~60s alarm here would misfire on every rolling update).
  - **`advert-stale`** — advert older than `advertStaleMs` (M5): treated as
    `unknown` (version-class after grace).
  - **`advert-rejected`** — clamp-rejected advert (M4): surfaced through the
    version-class confirmation path with its own named reason.
- **Dimensions + confirmation gates (Frontloaded Decision D2 pins the
  numbers):**
  - **Flag skew** — any manifest-intersection key whose effective values
    differ across compared machines. Confirmed after `flagConfirmTicks`
    consecutive evaluator ticks seeing the same divergence (default **2**,
    the GuardPostureProbe persistence pattern —
    `PERSISTENCE_TICKS` at `src/monitoring/probes/GuardPostureProbe.ts:54`);
    worst-case alarm latency ≈ 60–90s. Confirmation rationale, corrected per
    M8: boot-read entries change only via restart (state, not flap), and
    live-read entries CAN flap without restart — which is why confirmation
    ticks matter for them, not a reason to skip confirmation.
    **Update-wave suppression (M6):** flag-skew confirmation between two
    machines is SUPPRESSED while their advertised `instarVersion`s differ OR
    while a version-skew grace window is open for the pair. An update that
    changes a flag's resolved default would otherwise alarm HIGH mid-wave and
    auto-resolve — the cry-wolf the version grace exists to prevent, on the
    louder dimension. Once versions agree (wave complete), any residual flag
    skew confirms normally.
  - **Version skew** — `instarVersion` differs. Differing **major.minor**:
    confirmed like flag skew (2 ticks). Differing **patch only**: confirmed
    only after `versionSkewGraceMs` (default **45 min**) of continuous skew —
    a normal update wave rolls machines sequentially (the restart-cascade
    dampener alone batches up to 15 min), and alarming mid-wave would make
    every auto-update cry wolf.
  - **Manifest-class skew (M7)** — `manifestHash` differs while
    `instarVersion` is IDENTICAL (a dirty/locally-built dist — a dev machine
    mid-dogfood): confirmed like flag skew, alarmed as its own named row
    ("same version, different coherence manifest — locally-built or dirty
    dist?"). Keys outside the intersection remain excluded from flag
    comparison; this dimension is what makes that shrinkage loud instead of
    silent.
  - **Protocol skew** — `protocolVersion` differs: confirmed like flag skew.
    The lease layer already treats a below-version machine as
    handoff-ineligible (`src/core/seamlessnessConfig.ts:16-27`); the guard
    makes the degradation visible.
- **Skew identity is canonicalized (N1):** a skew row's persistence key is
  `dimension + '|' + key + '|' + sorted('<machineId>=<valueClass>')` — stable
  machine ids and clamped value classes only, never nicknames (which can be
  renamed mid-episode) and never raw table rows. Confirmation counters,
  episode membership, and the recurrence damper (§4.5) all key on this
  identity.
- **Post-restart warm-up (N8):** `MachinePoolRegistry` is in-memory; a local
  restart wipes every peer's advert until the next 30s pull. For
  `warmupTicks` (default **4**) after boot, `unknown`/`advert-stale`
  classifications count toward NOTHING (no confirmation progress, no
  version-class grace clock) — a restart must not manufacture version-class
  signals on all peers.
- **Fail toward silence:** any evaluator error, an unreadable pool view →
  no emit this tick, an error counter on the status route (§6). A guard that
  can flood on its own malfunction re-creates the disease it treats. (Note
  the one deliberate exception carved out of "silence": a clamp REJECTION is
  not an evaluator error — it is data about the peer, routed to
  `advert-rejected` per M4, precisely so malformation cannot buy silence.)
- **Single-machine: strict no-op.** Zero online peers ⇒ empty comparison set ⇒
  the evaluator returns an empty verdict before any state is touched.
- **Supervision tier (N6):** Tier 0, explicitly: the sentinel is fully
  deterministic — manifest resolution, string comparison, counters; no LLM
  call anywhere in its path (Token-Audit Completeness is trivially satisfied;
  there is nothing for a Tier-1 supervisor to validate that the unit tests do
  not already pin).

### 3.4 Raiser election — exactly ONE machine owns the alarm (C1)

The evaluator runs on EVERY machine whose guard resolves live or dry-run, but
the attention surface is owned by exactly one. Without this, every live-guard
machine confirms the same skew and each mints its own HIGH item —
`createAttentionItem`'s idempotency is machine-local only (an in-memory
per-machine map + per-bot state file, `src/messaging/TelegramAdapter.ts:3799-3802`,
`:450`), so property (b) would fail by construction on the exact two-dev-pair
topology the §7 soak and §9 acceptance run on.

- **Candidates:** the machines (self + compared peers) whose advertised
  `guard` field (§3.2) reads `'live'` (enabled and not dry-run). Self's
  posture is known locally; peers' via their adverts. A `'dry-run'` machine is
  NOT a candidate (it records would-raise counters locally — per-machine
  dry-run telemetry stays intact); a `'dark'`/advert-less machine is not a
  candidate.
- **Election (deterministic, recomputed each tick, no coordination):** the
  raiser is the serving-lease holder if it is a candidate; otherwise the
  lexicographically SMALLEST `machineId` among candidates. Every machine
  computes the election from the same shared inputs (pool view + lease view)
  and simply compares the result to its own id: `raiser === self` gates all
  attention-surface mutations (create / update / resolve / escalate). Standbys
  and non-raisers evaluate, count, and append jsonl — they never touch the
  attention surface.
- **Zero candidates:** nobody raises. A pool where the guard is dark or
  dry-run everywhere has, honestly, no live guard — and the guard's own
  posture is a manifest row (§3.1, N2), so a HALF-dark pool is itself a
  named skew the live side alarms on.
- **Episode ownership is sticky:** the machine that OPENS an episode's item
  owns that episode's surface for its whole life (update / resolve /
  escalate), even if the lease moves mid-episode — an item can only be
  updated/resolved by the machine that holds it locally, so ownership follows
  the item, not the lease. Election therefore matters at episode OPEN (and at
  takeover, next bullet).
- **Owner-loss takeover (bounded):** if the episode owner leaves the candidate
  set (offline, or its guard leaves `'live'`) for more than
  `raiserTakeoverTicks` (default **10** ticks ≈ 5 min) while the skew
  persists, the currently-elected raiser takes over: it raises its OWN item
  for the episode, whose body opens with "taking over coherence episode
  <episodeId> from <nickname> (no longer able to alarm)". Takeover is latched
  once per (episode, lost owner) — never a per-tick stream. If the old owner
  later returns and still holds its open local item, it resolves that item
  with the marker `superseded-by-takeover` (never "restored"). This is the
  one accepted seam where two items can transiently exist for one episode —
  bounded to one takeover per owner loss, both items cross-referencing the
  same episodeId, and the stale one closes itself with an honest marker on
  the owner's return.
- **Split-brain honesty:** during a genuine network partition, each side's
  election sees only its own partition — two raisers can coexist until the
  partition heals (each honestly alarming about the machines it can see;
  the partition itself is the rope-health/split-brain machinery's alarm to
  own, and §2.4's `splitBrainItemOpen` gate already suppresses secondary
  monitors during it). On heal, sticky ownership + the takeover latch
  converge the surface back to one item; the duplicate resolves
  `superseded-by-takeover`.

**Multi-machine posture of every new surface** (the mandatory integration
declaration):

| Surface | Posture |
|---|---|
| `coherenceAdvert` (heartbeat field) | replicated by construction — carried on the existing signed presence pull |
| Episode state file (`<stateDir>/state/machine-coherence-episode.json`) | machine-local BY DESIGN (each machine latches its own view; only the raiser's episode drives the alarm). Agent-scoped `stateDir` rooting (N7) so multiple agents/test instances on one host cannot collide. |
| Attention item | raised on exactly ONE machine (the elected raiser; §3.4). Visible pool-wide via the existing `GET /attention?scope=pool` merge. |
| `logs/machine-coherence.jsonl` | machine-local, written by EVERY evaluating machine (observability everywhere; the raiser's rows additionally record surface mutations) |
| `GET /pool/machine-coherence` status route | machine-local read (each machine reports its own evaluator + election view; no proxy in v1 — asking two machines and comparing IS the diagnostic when the guard itself is suspect) |
| `awakeMachineCount` (§5b) | machine-local computation over that machine's own lease observations — each machine answers for itself; the source tag says which basis spoke |

## 4. Alerting — one episode, one item, honest lifecycle, bounded recurrence

### 4.1 Episode semantics

An **episode** opens when the first skew row is confirmed. Episode state is
durable JSON under `<stateDir>/state/machine-coherence-episode.json` (N7:
`stateDir` is the per-agent state root — never a shared/global path; atomic
tmp+rename; corrupt-file handling per §4.6), so a server restart mid-episode
neither re-alarms nor forgets. `episodeId` format is pinned (N4):
`mc-<openedAtEpochMs>` minted by the machine that opens the episode (under
§3.4 exactly one machine opens; the id needs no cross-machine coordination —
takeover items carry the SAME episodeId with a `-t<n>` suffix on the item id
only).

New skew rows confirmed while an episode is open **join the open episode**
(the item is updated in place + one short append on its topic), never a second
item — per-flag items are the named anti-pattern this spec exists to avoid.

### 4.2 The ONE attention item

- Raised via the existing chokepoint `telegramAdapter.createAttentionItem`,
  which is idempotent on item id (`src/messaging/TelegramAdapter.ts:3798-3802`)
  — the id is `machine-coherence:<episodeId>`, so re-raising within an episode
  on the SAME machine is structurally a no-op. (Cross-machine dedup is NOT
  provided by this chokepoint — that is §3.4's election, stated here so nobody
  re-reads idempotency as pool-scope.)
- Priority **HIGH** — a halved cross-machine guarantee is operator-actionable
  (Frontloaded Decision D4). HIGH is never coalesced by the topic-flood guard
  (`src/messaging/TelegramAdapter.ts:3858-3864`), so the alarm always gets its
  own visible surface. **Budget honesty (M2):** HIGH attention items are
  created with `origin: 'system'` (`src/messaging/TelegramAdapter.ts:3862`),
  and the universal topic-creation budget counts ONLY `origin: 'auto'`
  (`:1432-1446`) — the flood ceiling does NOT bound this path. The spec's own
  brakes (§4.5's recurrence damper + per-day cap, §4.3's suspension, §4.4's
  single escalation) are therefore NORMATIVE and load-bearing, not
  belt-and-suspenders over a platform backstop.
- **Body contract (M9 — Agent Proposes, Operator Approves; Operator-Surface
  Quality):** the body leads with plain-language impact and a fix the AGENT
  performs on approval — never a config recipe the operator must execute:
  1. **Impact first, plain language:** "My two machines have drifted apart —
     **the laptop** and **the mini** aren't running as the same me:
     conversation-moves between machines will silently fail." (The manifest
     entry's `guarantee` line, rendered per skew row, by nickname.)
  2. **A complete proposed fix, approve-to-execute:** "Reply **fix it** and
     I'll equalize `<flag>` on <nickname> (I'll set it explicitly and restart
     that machine's server — a ~30-second blip there), or reply **leave it**
     and I'll keep this episode open without further nagging." The agent —
     not the operator — performs the config write on approval, and when it
     does, it writes the FULL nested config block (read-modify-write of the
     whole `multiMachine.seamlessness` object), NEVER a partial nested PATCH:
     the one-level-deep config merge erases sibling keys on a partial block
     (the documented `PATCH /config` clobber hazard) — a skew "fix" must
     never create new skew.
  3. **Technical detail last, in a secondary block:** dimension, key,
     per-machine effective values, manifestHash — for the operator who wants
     it. NO raw `PATCH /config` command lines, NO dotted-config-key-first
     framing anywhere in the body.
- **Exposure invariant (L2, stated normatively):** alarm rows render ONLY
  local-manifest-intersection keys and clamp-passed enum value classes — never
  a peer's free text, never paths, never anything outside the §3.1 clamp
  alphabet. (The body does reveal which safety flags are dark/dry-run on which
  machine, to the operator-only attention surface — the same information
  `GET /guards` already serves that operator.)

### 4.3 Close-reason taxonomy — auto-resolve never lies (M1)

An episode CLOSES only through one of these named reasons; **only `restored`
may claim restoration**:

- **`restored`** — a full evaluator pass over a comparison set that still
  CONTAINS every machine participating in the episode's skew rows finds zero
  skew for `resolveTicks` (default **3**) consecutive ticks. The item is
  PATCHed resolved + ONE resolution note lands on its topic
  ("machine-coherence restored — <keys> now agree across <nicknames>, held
  for <resolveTicks> ticks").
- **`suspended-peer-offline`** — a machine participating in the episode's
  skew leaves the online set (nightly laptop sleep is the canonical case).
  The episode does NOT resolve: it SUSPENDS — the item stays open, ONE short
  append notes "the divergent machine (<nickname>) went offline — holding
  this open; I'll re-check when it returns", the escalation clock (§4.4)
  PAUSES, and resolve-tick counting stops (a pass whose comparison set lost
  the skew participant counts toward NOTHING — M1's changed-set rule). When
  the peer returns: skew still present → the SAME episode resumes silently
  (same item, no new topic, confirmation not re-required for already-confirmed
  rows); skew gone → close `restored` via the normal resolve-ticks path.
  Without this, one persistent skew on a sleep-cycled machine would mint a
  false "restored" marker plus a fresh HIGH topic per day, indefinitely.
- **`expired-peer-gone`** — a suspended episode whose participant has stayed
  offline past `suspendedEpisodeExpiryMs` (default **7 days**) closes with
  this honest marker ("the divergent machine never came back — closing; a
  fresh divergence will open a new episode"). Never rendered as "restored".
- **`superseded-by-takeover`** — §3.4 owner-return case.
- **`resolved-after-reenable`** — §4.6 disable/re-enable disposal.

### 4.4 Escalation only on persistence

If an episode stays open (unsuspended clock) past `escalateAfterMs` (default
**24 h**), exactly ONE escalation append on the existing item's topic ("still
divergent after 24h"). Then silence — bounded, level-triggered, P19. The
episode latch is the `FailureEpisodeLatch` shape
(`src/core/FailureEpisodeLatch.ts:1-60`): signal once per episode, stay quiet
while the condition persists, reset on recovery. Suspension (§4.3) pauses this
clock — an offline peer must not accrue "still divergent" time it cannot fix.

### 4.5 Recurrence damper + per-day cap (M2)

The P19 brakes inside one episode are not enough; episode RECURRENCE needs its
own brake (a flapping skew would otherwise cycle open→close→NEW-episode every
~2.5 min at defaults):

- **Recurrence damper:** a newly-confirmed skew whose row-identity set (N1)
  intersects an episode closed within `reopenWindowMs` (default **60 min**)
  RE-OPENS that episode — same item un-resolved + one short append ("this
  divergence is back — re-opening"), same topic, no new item. The re-open
  count is carried on the item.
- **Per-day cap, gives up loudly:** at most `maxEpisodeItemsPerDay` (default
  **3**) NEW episode items per rolling 24 h (re-opens don't count — they
  create no item). Past the cap, further confirmed episodes are recorded
  jsonl-only + counted on the status route, and ONE final append on the most
  recent item says "coherence is flapping faster than I'll alarm — N further
  episodes today recorded silently; see /pool/machine-coherence" — the P19
  give-up-loudly pattern, never an unbounded stream and never silent
  swallowing.

### 4.6 Corrupt state + disable-mid-episode disposal (N3, N4)

- **Corrupt episode file:** re-baseline without crashing (the GuardPostureProbe
  pattern) — but BEFORE raising anything from the fresh baseline, the raiser
  first ADOPTS-or-RESOLVES any open `machine-coherence:*` attention item it
  holds locally: if the fresh evaluation confirms the same skew, the existing
  item is adopted (updated in place, new episodeId cross-referenced); if not,
  the existing item is resolved with marker `state-rebaselined`. The §4.1
  restart guarantee ("neither re-alarms nor forgets") thereby survives the
  corrupt-file path too — a re-baseline can never mint a duplicate HIGH item
  while the old topic is open.
- **Disabled mid-episode:** the status route 503s (dark posture), the episode
  state file is RETAINED as-is, and the open item stays open for manual ack —
  disabling the guard is not evidence the skew healed, so nothing auto-
  resolves. On a later ENABLED boot: if the pool evaluates coherent, the
  stale item is resolved with marker `resolved-after-reenable`; if the skew
  persists, the retained episode resumes.

## 5. The `awakeMachineCount` telemetry fix (named sub-item)

Two independent corrections, shipping as bug-fixes (live, not dev-gated — they
correct an existing lying surface; see §7 for the boundary):

**5a. Version telemetry actually populated.** `src/commands/server.ts:17094`
passes the running version:
`captureHardware(ProcessIntegrity.getInstance()?.runningVersion)` — and when
`ProcessIntegrity` is unavailable the argument is OMITTED so the field stays
honestly absent (L1: never stamp a possibly-stale `config.version` — a
different-meaning source — as durable telemetry). This retroactively activates
the already-written consumer at `src/server/routes.ts:6645/6671` (peer-version
annotation on `/guards?scope=pool` failure rows) and gives the registry a
durable version-per-machine record. The LIVE per-beat truth still comes from
the §3.2 advert (the registry copy is boot-stale by design — hardware
self-attest only rewrites on change, `src/core/MachineIdentity.ts:443-448`).

**5b. `awakeMachineCount` derives from a NEW per-peer lease-observation view.**

**Honest grounding (C2 — corrected from the round-0 draft):** the pull loop
does NOT already collect a per-peer view. `LeaseCoordinator.observedPeerLease()`
returns ONE most-recently-observed record — a single latest slot
(`src/core/LeaseCoordinator.ts:464-478`, backed by
`HttpLeaseTransport.lastObserved`, `src/core/HttpLeaseTransport.ts:368-370`) —
and the contested latch compares only that single record against self
(`src/core/MultiMachineCoordinator.ts:1341-1355`). Moreover the pulled record
is the peer's lease **VIEW** (its effective view can re-serve a THIRD machine's
lease — `pullPeer`'s own doc says so, `src/core/HttpLeaseTransport.ts:415-421`),
not a self-claim. The count therefore needs NEW retained state:

- **New state:** `HttpLeaseTransport` gains a per-peer observation map —
  `lastPulledByPeer: Map<peerMachineId, { lease: LeaseRecord | null,
  observedAtMs: number }>` — recorded inside `pullPeer()`
  (`src/core/HttpLeaseTransport.ts:424-435`), keyed on the DIALED peer's
  registry machine id (the identity machine-auth verified — never the response
  body's holder claim), pruned when a peer leaves `this.d.peers()`. Exposed as
  `observedByPeer()`, surfaced on `LeaseCoordinator` as
  `peerLeaseObservations()`. `pullAllPeers()` currently DISCARDS per-peer
  results (`:440-445`) — the map is filled from the same dials it already
  makes; zero new network traffic.
- **Counting rule (each ambiguity pinned):** `awakeMachineCount` =
  (self `holdsLease()` ? 1 : 0) + the number of DISTINCT online peers **P**
  whose observation satisfies ALL of: (i) **freshness** — `observedAtMs`
  within `leaseObservationStaleMs` = 3 × the lease-pull interval (floor 30 s;
  a stale observation contributes nothing — the post-failover stale-claim
  overcount dies here); (ii) **liveness** — the observed lease is NOT expired
  (an expired lease carries no authority — the same rule the supersede gate
  already enforces, `src/core/LeaseCoordinator.ts:480-505`); (iii)
  **self-claim** — `lease.holder === P`. A pulled lease naming a THIRD
  machine is that peer's hearsay about someone else: it contributes NOTHING
  to the count (the third machine's own self-claim is captured when IT is
  pulled). Duplicate ids are impossible by map keying; `holder === P ≠ self`
  means self can never be double-counted. Source tag: `'lease-live'`.
- **Advisory, never authority (L4/SEC-4, stated here where the data lives):**
  peer lease claims are self-asserted advisory data. The count and a
  `contested` verdict route to dashboards and to the existing human-decision
  attention flow — they NEVER drive an automatic demotion. (Demotion authority
  remains exclusively with the existing strictly-higher-epoch supersede gate
  and the operator "demote machine X?" flow.)
- **Legacy heartbeat mode** (no lease coordinator, or `canPullPeers()` false —
  a git-only mesh): keep the registry-role count, tagged `'registry-roles'` —
  with its staleness now named instead of implied.
- **Read failure is honest:** an unreadable underlying source yields
  `awakeMachineCount: null` + source `'unavailable'` — never a silent 0
  (today's `:973` catch). `splitBrainState` keeps its derivation semantics
  (`contested` iff live count > 1 or `leasePullContested`); with a null count
  it degrades to the latch alone. The three in-code `splitBrainState`
  consumers (§2.4: ingress suppression `server.ts:4959`, speaker-election
  `leaseStable` `:12383`, rope-health `splitBrainItemOpen` `:20604`) keep
  their exact current behavior — the suppression path's own catch already
  fails toward the safe direction on ANY status-read error, independent of
  this change.
- **Surface shape (Frontloaded Decision D5 — M10 decided in-spec):**
  `MultiMachineSyncStatus.awakeMachineCount` becomes `number | null` and gains
  a sibling `awakeMachineCountSource: 'lease-live' | 'registry-roles' |
  'unavailable'` (`src/core/MultiMachineCoordinator.ts:41-85`). This is a
  BREAKING change to a published surface, made deliberately: the compat
  alternative (keep `0` + add a tag) preserves the exact lie the fix removes.
  The SAME PR must therefore sweep every consumer and contract:
  - the `getSyncStatus()` docstring "Always returns valid fields (never
    null/throws)" (`src/core/MultiMachineCoordinator.ts:960-964`) — rewritten
    to the new contract (never throws; `awakeMachineCount` may be null,
    source-tagged);
  - the `/health` serializer + its comment (`src/server/routes.ts:2575-2581`)
    and `GET /pool`'s router block (`:13564-13580`) plus the two other
    `getSyncStatus()` route callers (`:13713`, `:13907`);
  - `tests/unit/multimachine-syncstatus.test.ts:46` (asserts
    `typeof === 'number'` — updated to the union + source tag);
  - `tests/e2e/multi-machine-lease-split-brain.test.ts:64,147` — proves
    partition detection via registry-role counting; REDESIGNED (not tweaked)
    to seed per-peer lease observations for the lease-live path and keep a
    registry-mode case for the legacy tag;
  - `tests/integration/pool-routes.test.ts:60` — fixture gains the new shape;
  - the two deployed CLAUDE.md template texts naming the field
    (`src/scaffold/templates.ts:507`, `src/core/PostUpdateMigrator.ts:4974`)
    — updated to the new shape via `generateClaudeMd()` + `migrateClaudeMd()`;
  - an upgrade-guide entry stating the shape change (`audience: agent-only`;
    no external/dashboard consumer exists — verified: no dashboard HTML reads
    `awakeMachineCount`).
- **`instar doctor` + `instar machine list` (M12 — the P0-1 half-open gap):**
  `doctor`'s Registry check counts `role === 'awake'` directly from registry
  rows (`src/commands/machine.ts:672-681`, the "N machines claim awake
  (split-brain?)" line at `:681`) and `machine list` renders the same rows —
  neither goes through `getSyncStatus()`. In-scope for the 5b PR: `doctor`
  additionally queries the local server's `/health` when reachable and prints
  the live count + source alongside the registry-role count, labeling any
  divergence ("registry says 2 awake; live lease view says 1
  ('lease-live') — registry roles may lag"); with no server running it keeps
  the registry count explicitly labeled "registry view (may lag — start the
  server for the live view)". `machine list` gets the same label on its role
  column header. The deployed CLAUDE.md sentence "`instar doctor` shows the
  same" becomes true again under the source-tag honesty rather than by
  accident.

The invariant this declares (Cross-Store Coherence Is an Invariant): *the
machine registry's role rows and the live lease/pull view answer the same
question; where they disagree, the live view wins and the surface says which
source spoke.*

## 6. Observability

- **Status route:** `GET /pool/machine-coherence` (Bearer-authed; **503 when
  the guard is dark on this agent** — the standard dark-route posture; the
  round-1 external's note that generic health tooling can misread 503 is
  recorded, and the house pattern deliberately wins — L3) →
  `{ enabled, dryRun, lastTickAt, machinesRegisteredOnline, machinesCompared,
  peerClassifications: { compared, unknown, advertStale, advertRejected },
  raiser: { machineId, isSelf, candidates }, openEpisode: { episodeId,
  openedAt, ownerMachineId, suspended, reopenCount, skews: [...] } | null,
  counters: { ticks, skewsConfirmed, wouldRaise, raised, reopened, resolved,
  suspended, escalated, takeovers, cappedEpisodes, clampRejections, errors } }`.
  Registry First: "are my machines coherent?" is a read, never a guess.
- **Audit log:** `logs/machine-coherence.jsonl` — one row per state
  TRANSITION (skew confirmed / episode open / key joined / suspended / resumed
  / reopened / episode closed(reason) / takeover / escalated / error-class
  change), never per-tick rows (the transition-only rule the mesh-coherence
  live check already follows). Written by every evaluating machine (§3.4
  posture table).
- **Guard inventory:** the sentinel registers in `GUARD_MANIFEST`
  (`src/monitoring/guardManifest.ts`) so `GET /guards` grades its posture like
  every other guard — a coherence guard that silently turned off must itself
  be a visible anomaly. NOT marked `loadBearing` in v1 (Frontloaded Decision
  D6): signal-only, no critical path consumes it yet, and `loadBearing:true`
  would raise G3 gap alarms on every fleet agent where it is deliberately
  dark. Revisit when Phase 2 consumes the advert.
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
    "versionSkewGraceMs": 2700000,   // 45 min
    "resolveTicks": 3,
    "escalateAfterMs": 86400000,     // 24 h
    "advertStaleMs": 300000,         // 5 min — older adverts degrade to advert-stale (M5)
    "warmupTicks": 4,                // post-boot: unknown/stale classes count toward nothing (N8)
    "reopenWindowMs": 3600000,       // 60 min — recurrence re-opens the same item (M2)
    "maxEpisodeItemsPerDay": 3,      // per-day new-item cap; past it, jsonl-only + one loud give-up (M2)
    "suspendedEpisodeExpiryMs": 604800000, // 7 d — suspended episode closes 'expired-peer-gone' (M1)
    "raiserTakeoverTicks": 10        // owner offline this long while skew persists → takeover (C1)
  }
}
```

- Registered in `DEV_GATED_FEATURES` (`src/core/devGatedFeatures.ts:45`) so the
  both-sides wiring test proves live-on-dev / dark-on-fleet resolution.
  Justification line: signal-only — raises at most one attention item per
  episode; no spend, no egress beyond the existing signed mesh reads, no
  destructive action; dry-run canary holds all sends.
- **What the gate covers vs what ships live (M3, restated normatively):** the
  dev-gate covers the EVALUATOR + episode/alarm machinery ONLY. Three things
  ship live for everyone: the §5 bug-fixes (5a/5b — correcting a false
  telemetry reading is not a new behavior and must not wait on a dev-gate),
  AND the §3.2 advert EMISSION (unconditional — a gated advert would make the
  guard misdiagnose the F4 topology itself; see §3.2 for the full rationale
  and the unit test that pins it).
- Graduation ladder: dark fleet → dev dry-run soak → dev live
  (`dryRun:false`) → fleet flip. **Soak criterion (Frontloaded Decision D7):**
  ≥ 5 days of dry-run rows on the live dev pair with zero false-positive
  would-raises, AND the soak must have witnessed ≥ 1 natural update wave with
  ZERO flag would-raises during the wave (proving the M6 suppression works —
  grace-suppressed version rows are expected and fine), AND one deliberately
  injected skew correctly detected. **Actor naming (N4):** the agent flips
  `dryRun:false` on the dev pair after presenting the soak evidence to the
  operator and receiving ack (Rung 1 approval); the FLEET flip (adding
  `enabled:true` to fleet ConfigDefaults or per-agent configs) is the
  operator's own action — the agent proposes it with the dev-live evidence,
  never performs it.
- **Migration parity, real artifacts (N9):** there is nothing for
  `migrateConfig()` to add for an omitted-`enabled` dev-gated feature with
  code-side `??` fallbacks (the tuning keys above also ship as code defaults;
  writing them to config is optional operator convenience, not a migration
  need). The REAL parity artifacts are: ConfigDefaults OMITS the block
  (asserted by the both-sides wiring test,
  `tests/unit/devGatedFeatures-wiring.test.ts`); the CLAUDE.md template gains
  the status-route + "why did I get a machine-coherence alarm?" proactive
  triggers via `generateClaudeMd()` AND reaches existing agents via
  `migrateClaudeMd()` (Agent Awareness + Migration Parity standards); and the
  M10 sweep updates the two existing `awakeMachineCount` template mentions
  (§5b) through the same pair.
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
  configs; each `readSource` mode (a live-read entry resolved from liveConfig,
  a boot entry from the boot object — M8); the F4 case reproduced (both
  configs omit the flag, `developmentAgent` differs → effective values
  differ).
- Manifest guards (N5): the size-ratchet test (>64 entries / >2 KB reference
  advert fails); the membership drift guard (a `multiMachine.*`
  DEV_GATED_FEATURES entry absent from both manifest and exclusion list
  fails).
- Advert emission unconditional (M3): an advert is built from a FLEET config
  (no `developmentAgent`, no `machineCoherence` block); `beatSeq` increments
  per beat.
- Receive clamp (M4): oversize/malformed adverts rejected with the rejection
  marker REPLACING the stored advert (last-good not carried forward as
  current); rejected peer classified `advert-rejected` and surfaced (not
  silent); clean adverts pass byte-identical.
- Staleness (M5): an advert older than `advertStaleMs` degrades to
  `advert-stale` even while `routerReceivedAtMs` stays fresh (the
  git-beat-refreshes-liveness case).
- Evaluator semantics, both sides of every boundary: no-skew pool → empty
  verdict; single flag divergence → confirmed only at `flagConfirmTicks`;
  flag skew SUPPRESSED while versions differ / version grace open, confirms
  after versions equalize (M6); patch-only version skew inside vs past
  `versionSkewGraceMs`; major.minor skew immediate (2 ticks); manifest-hash
  mismatch with equal versions → manifest-class row (M7); manifest-hash
  mismatch with differing versions → version-class only; offline peer
  excluded; advert-less online peer → `unknown` + version-class only after
  grace (M3); registered-online-but-uncompared peer → `unknown`, universe
  shrinkage visible (M11); warm-up: unknown/stale count toward nothing for
  `warmupTicks` (N8); skew identity stable under nickname change (N1).
- Raiser election (C1): lease-holder-live → holder raises; holder dry-run →
  lowest-machineId live candidate raises; zero candidates → nobody; dry-run
  machine records would-raise but never raises; election recomputation
  flips `raiser.isSelf` when the lease moves BUT an open episode's surface
  stays with its owner (sticky); owner-loss past `raiserTakeoverTicks` →
  exactly one takeover item, latched; owner return → old item resolved
  `superseded-by-takeover`.
- Episode lifecycle: open → key joins → close `restored` at `resolveTicks`;
  skew-participant offline → `suspended-peer-offline` (item open, escalation
  clock paused, changed-set passes count toward nothing — M1); peer returns
  with skew → same episode resumes, no new item; peer returns clean →
  `restored`; suspended past expiry → `expired-peer-gone` (never "restored");
  recurrence within `reopenWindowMs` → same item re-opened, no new topic
  (M2); >`maxEpisodeItemsPerDay` → jsonl-only + one loud give-up append (M2);
  escalation fires exactly once; durable state survives reload; corrupt state
  file re-baselines AND adopts-or-resolves the open item first, no duplicate
  HIGH (N3); disable-mid-episode retains state + item; re-enable on a
  coherent pool resolves `resolved-after-reenable` (§4.6).
- `awakeMachineCount` derivation (5b): per-peer observation map recorded from
  `pullPeer` keyed on the dialed registry id; self-claim-only counting (a
  pulled lease naming a third machine contributes nothing); expired lease
  excluded; stale observation (past `leaseObservationStaleMs`) excluded;
  dual self-claim ⇒ 2 + `contested`; legacy registry mode tagged
  `'registry-roles'`; unreadable source ⇒ `null` + `'unavailable'` (NOT 0);
  `splitBrainState` derivation unchanged with a null count (latch-only).
- `captureHardware(version)` stamps `hardware.instarVersion`; unavailable
  ProcessIntegrity → field absent, never `config.version` (L1).

**Tier 2 — integration (`tests/integration/`):**
- `GET /pool/machine-coherence`: 503 when dark; 200 with live counters when
  enabled; dry-run reports `wouldRaise` without an item; classification +
  raiser blocks present.
- Injected skewed heartbeats across ≥ `flagConfirmTicks` ticks → exactly ONE
  attention item exists on the RAISER machine (id-stable across further
  ticks) and ZERO on a second live-guard machine in the same fixture pool —
  the pool-scope property (b) test C1 demanded; skew cleared → item resolved
  + one resolution note; recurrence inside the window → re-open, not a new
  item.
- `/health` + `GET /pool` serve the new count shape + source tag;
  registry-unreadable fixture serves `null`/`'unavailable'`.
- Advert pass-through ratchet: `SESSION_STATUS_ADVERT_FIELDS` includes
  `coherenceAdvert` (the existing ratchet test auto-covers the narrowing);
  clamp-rejected advert visible as `advert-rejected` classification via the
  status route.
- Wiring integrity: the sentinel's deps (registry, attention emitter, lease
  view, clock) are real, non-null, delegating — per the DI standard.

**Tier 3 — E2E lifecycle (`tests/e2e/`):**
- The Phase-1 "feature is alive" test: production init path with a
  dev-agent config → status route 200, evaluator ticking; fleet config →
  503 BUT the advert still emitted (M3's live/dark boundary proven at the
  lifecycle tier); single-machine config → alive but `machinesCompared: 1`,
  zero episodes ever.
- The redesigned split-brain e2e (M10): lease-live counting path through a
  seeded per-peer observation fixture + a registry-mode legacy case.

**Acceptance battery — the roadmap live-proof clause, restated (D2):**
1. *"Deliberately skew a flag on one machine → alarm within one heartbeat
   cycle"* — restated honestly as **≤ 2 presence-pull cycles (≤ 90 s)** at the
   shipped `flagConfirmTicks: 2`. On the live dev pair (dev-live rung): flip
   one manifest flag explicitly on one machine + restart it → ONE HIGH
   attention item, raised by the elected raiser ONLY, naming the key, both
   nicknames, and the guarantee, within `flagConfirmTicks × 30s` of the
   machine's first post-restart beat. Un-skew → the same item auto-resolves
   with the `restored` marker. Zero further messages in between, and zero
   items on the non-raiser machine (the pool-scope one-item property observed,
   not assumed).
2. *"Matrix transfer scenario passes with zero manual config surgery."* Re-run
   the S3/S5 cross-machine NL-move scenario from the 2026-07-02 matrix on a
   coherent pair: the guard is SILENT throughout (no false positive), and the
   transfer actuates without any hand-edit of either machine's config. Then
   re-introduce the F4 asymmetry: the guard names it BEFORE the move is
   attempted — the operator-visible difference between "silent pending
   forever" and "one alarm proposing the one-tap fix". (Honest scope: this
   build detects and names; the alarm's proposed fix is agent-performed on
   operator approval (§4.2); unattended auto-equalization is Phase 2's
   authority question.
   <!-- tracked: roadmap-2026-07/phase-4.1-updater-coordination -->)
3. `awakeMachineCount` live probe: on the healthy pair, `/health` reports
   `1` + `'lease-live'` (never 0) with the Mini holding the lease; killing
   the holder and forcing failover never yields a silent 0 during the
   transition (a transient `null`/`'unavailable'` is acceptable and honest;
   `0`+`'lease-live'` with a live holder is the bug).
4. Sleep-cycle honesty (M1): put the skewed peer to sleep overnight mid-
   episode → the item suspends (one append), does NOT resolve "restored",
   and NO new topic exists next morning; wake with skew intact → same item
   resumes.

## Frontloaded Decisions

Round-1 C3: all seven round-0 open questions are decided here (per the
proposed resolutions appended to the round-1 findings report), plus the
decisions the round-1 findings forced. None remain parked.

- **D1 (was Q1) — Comparison basis + membership.** Compare RESOLVED effective
  values (post dev-gate, dry-run folded). A `developmentAgent` asymmetry
  inside one agent's pool is ALWAYS alarmed — mixed-dev pools are not a
  supported topology; no per-key suppression list in v1. Membership: the §3.1
  table as drafted, KEEPING `meshTransport.enabled` (a single-rope pool
  varying it legitimately is not observed in practice; if a legit topology
  emerges, removal is a one-line manifest change — the manifest is
  code-shipped, additions/removals are follow-up-cheap), PLUS per-entry
  `readSource` (M8) and the guard's own posture row (N2). `topicProfiles` /
  `subscriptionPool` posture: excluded — per-machine by design (seat/quota
  state is genuinely machine-local), recorded in the N5 exclusion list.
- **D2 (was Q2) — Confirmation defaults vs the roadmap clause.**
  `flagConfirmTicks: 2` (house persistence pattern; the extra ≤ 30 s buys
  pull-jitter immunity). The roadmap acceptance clause is RESTATED as "≤ 2
  presence-pull cycles (≤ 90 s)" — honesty over literalism (frontmatter note
  + §9.1). `versionSkewGraceMs: 45 min` kept, extended to advert-less
  (`unknown`) peers (M3) and to flag-skew suppression during version
  disagreement (M6).
- **D3 (was Q3) — Advert placement.** New `coherenceAdvert` block. Decisive
  argument: `seamlessnessFlags` has load-bearing emission-gate consumers;
  the "fixed-size booleans only" contract half is precedent-eroded (L5) and
  is cited only as secondary.
- **D4 (was Q4) — Alarm surface.** HIGH attention item with its own topic —
  an operator-actionable config decision, not housekeeping. Body rewritten
  per M9 (§4.2); the item is exempt from the topic budget (origin:'system'),
  so §4's own brakes are normative (M2).
- **D5 (was Q5) — `awakeMachineCount` shape.** `number | null` + source tag,
  shipped WITH the full consumer/test/template/docstring sweep in the same PR
  (§5b). The compat alternative (keep `0`) preserves the exact lie the fix
  removes. Published-surface change ⇒ decided in-spec, never deferred.
- **D6 (was Q6) — Guard posture weight.** NOT `loadBearing` in v1 —
  signal-only, no critical path consumes it yet, and the flag would raise G3
  gap alarms on every fleet agent where the guard is deliberately dark.
  Revisit when Phase 2 consumes the advert.
- **D7 (was Q7) — Soak criterion.** ≥ 5 days dry-run on the live dev pair,
  zero false-positive would-raises, AND ≥ 1 witnessed natural update wave
  with zero flag would-raises during the wave, AND one injected skew
  correctly detected (§7).
- **D8 (C1) — Raiser election.** Lease-holder-if-live, else lowest machineId
  among live-guard candidates; sticky episode ownership; bounded takeover
  (§3.4).
- **D9 (M1) — Close-reason taxonomy.** `restored` / `suspended-peer-offline`
  / `expired-peer-gone` / `superseded-by-takeover` /
  `resolved-after-reenable`; only `restored` claims restoration; suspension
  pauses the escalation clock; changed-set passes count toward nothing
  (§4.3).
- **D10 (M2) — Recurrence brakes.** Re-open window 60 min; ≤ 3 new episode
  items/day, then jsonl-only + one loud give-up (§4.5).
- **D11 (M4) — Clamp-rejection semantics.** Rejected ≠ absent: rejection
  marker replaces the stored advert, peer surfaces as `advert-rejected`
  (§3.2).
- **D12 (M5) — Advert staleness.** `beatSeq` + receipt stamp;
  `advertStaleMs: 5 min` → `advert-stale` (§3.2).
- **D13 (M7) — Manifest-class dimension.** hash≠ ∧ version= is its own
  confirmed skew row; hash covers entries, not keys (§3.1/§3.3).
- **D14 (M9) — Alarm body contract.** Impact-first plain language;
  agent-performed fix on approval; full-block config writes only; technical
  detail in a secondary block; no raw PATCH recipes (§4.2).
- **D15 (M12) — doctor/machine-list scope.** `doctor` gains the live
  count + source alongside the labeled registry count (same PR as 5b);
  `machine list` labels its role column as registry-view (§5b).
- **D16 (N4) — episodeId + disposal + actors.** `mc-<openedAtEpochMs>`;
  disable-mid-episode retains state + item (manual ack or
  `resolved-after-reenable`); agent flips dev `dryRun:false` after
  operator-acked soak evidence; operator owns the fleet flip (§4.6, §7).
- **D17 (N6) — Supervision tier.** Tier 0, justified: fully deterministic,
  no LLM calls (§3.3).
- **D18 (N7/N8) — State rooting + warm-up.** Agent-scoped `stateDir` rooting;
  `warmupTicks: 4` post-boot with unknown/stale counting toward nothing.

## Decision points touched

- The guard introduces **no block/allow/route gates** — it is signal-only end
  to end (evaluator → attention item). The only actuation anywhere in its
  design is the §4.2 agent-performed fix, which executes solely on explicit
  operator approval per episode (Agent Proposes, Operator Approves).
- §5b **modifies the inputs feeding three existing in-code gates** that
  consume `splitBrainState` (ingress step-down suppression, WS3
  speaker-election `leaseStable`, rope-health `splitBrainItemOpen` — §2.4):
  their observed behavior is preserved by keeping `splitBrainState`'s
  derivation semantics (contested iff live-count > 1 or the contested latch;
  null count degrades to latch-only). No gate's fail direction changes.
- §5b changes one **published read surface** (`awakeMachineCount` shape) —
  decided in-spec as D5 with the full same-PR sweep.

## Open questions

*(none — all resolved into Frontloaded Decisions above)*

## 11. Verified code-grounding index

Every citation checked in this worktree (branch `echo/machine-coherence-guard`
at v1.3.728; drifted line numbers from round 0 corrected in the round-2 pass).

| Fact | Where |
|---|---|
| `awakeMachineCount` counts local-registry `role === 'awake'` rows; silent 0 on read failure; feeds `splitBrainState` | `src/core/MultiMachineCoordinator.ts:966-1003` (count `:967-973`, catch `:973`, splitBrain `:977-981`) |
| `splitBrainState` load-bearing consumers (behavior preserved by 5b) | `src/commands/server.ts:4959` (ingress suppression, fails safe on read error), `:12383` (speaker-election leaseStable), `:20604` (rope-health splitBrainItemOpen) |
| In-code admission the registry count misses a git-less mesh | `src/core/MultiMachineCoordinator.ts:198-208` |
| Role rows written only on self transitions | `src/core/MultiMachineCoordinator.ts:1182-1189` |
| Registry merge: later-`lastSeen` entry wins whole-row | `src/core/mergeRegistry.ts:37-53`; conflict hook `src/core/GitSync.ts:1054-1065` |
| `lastSeen` refreshed by non-role writers | `src/core/MachineIdentity.ts:380` (register), `:412` (nickname) |
| `hardware.instarVersion` exists but the only callsite omits it | type `src/core/types.ts:1951`; `captureHardware` `src/core/MachinePoolRegistry.ts:27-38`; callsite `src/commands/server.ts:17094` |
| A consumer already reads the never-populated peer version | `src/server/routes.ts:6645`, `:6671` |
| Truthful own-version source | `src/core/ProcessIntegrity.ts:92`; used at `src/server/routes.ts:6617` |
| Rich self-beat built + 30s cadence | `src/commands/server.ts:17180-17222` (flags `:17203`), interval `:17251` |
| Peer presence pull + 30s cadence + advert-field ratchet | `src/core/PeerPresencePuller.ts:101-150`; scheduled `src/commands/server.ts:20172` |
| Receive path is verbatim pass-through TODAY (the clamp is NEW work — M4) | `src/core/PeerPresencePuller.ts:122-150` (narrowing), `src/core/MachinePoolRegistry.ts:209-278` (recordHeartbeat); the types.ts:2075-2078 comment documents identity-binding + receipt-age only |
| Observation identity keyed on registry machine id, never body-claimed | `src/core/PeerPresencePuller.ts:243-254` |
| Heartbeat field carry-forward pattern | `src/core/MachinePoolRegistry.ts:229-267` (fields `:239-255`) |
| Coarse git beat refreshes liveness WITHOUT an advert (M5's gap) | `src/commands/server.ts:17225-17236`; `src/core/MachinePoolRegistry.ts:212-227` |
| `seamlessnessFlags` contract + its precedent erosion (L5) | `src/core/types.ts:2027-2074` (contract `:2034`; `stateSyncReceive` map inside it `:2062-2074`) |
| Existing comparator is stateSync-only, boot-log-only | `src/core/ReplicatedRecordEnvelope.ts:665-700`; wiring `src/commands/server.ts:17254-17289` |
| ws43 cutover already refuses incoherent pools (quietly) | `src/commands/server.ts:17070-17090` |
| Dev-gate resolution + feature registry | `src/core/devAgentGate.ts:44-47`, `:69-84`; `src/core/devGatedFeatures.ts:45` |
| `sessionPool.stage` is read via liveConfig — no restart needed (M8) | `src/commands/server.ts:20177-20186` (`_sessionPoolStage` → `liveConfig.get('multiMachine.sessionPool', …)`) |
| `exactlyOnceIngress` default derives from `sessionPool.stage` | `src/core/seamlessnessConfig.ts:126-128`; protocol version `:28` |
| Attention item id-idempotency is MACHINE-LOCAL (in-memory map + per-bot state file — why C1 needs the election) | `src/messaging/TelegramAdapter.ts:3798-3802`, `:450` |
| HIGH items are `origin:'system'`; the universal topic budget counts only `origin:'auto'` (M2) | `src/messaging/TelegramAdapter.ts:3862` (origin), `:1432-1446` (budget) |
| HIGH never coalesced by the flood guard | `src/messaging/TelegramAdapter.ts:3858-3864` |
| Episode-latch + persistence-ticks house patterns | `src/core/FailureEpisodeLatch.ts:1-60`; `PERSISTENCE_TICKS` `src/monitoring/probes/GuardPostureProbe.ts:54` |
| `observedPeerLease()` is a SINGLE most-recent slot (C2's ground truth) | `src/core/LeaseCoordinator.ts:464-478`; `HttpLeaseTransport.observed()` `src/core/HttpLeaseTransport.ts:368-370` (single `lastObserved`) |
| The contested latch compares only that single record | `src/core/MultiMachineCoordinator.ts:1341-1355` |
| `pullPeer` returns per-peer leases (which may name a third machine); `pullAllPeers` discards them today — the seam 5b's new map fills | `src/core/HttpLeaseTransport.ts:415-435` (pullPeer + its doc), `:440-445` (pullAllPeers) |
| Expired/lower-epoch peer leases carry no authority (the rule 5b's liveness condition reuses) | `src/core/LeaseCoordinator.ts:480-505` (supersede gate + 2026-06-02 incident doc) |
| `doctor` + `machine list` count registry roles directly (M12) | `src/commands/machine.ts:672-681` (doctor, "claim awake (split-brain?)" `:681`), `:65`, `:169` (list) |
| Deployed template texts naming `awakeMachineCount` (M10 sweep) | `src/scaffold/templates.ts:507`; `src/core/PostUpdateMigrator.ts:4974` |
| Named tests broken by the shape change (M10 sweep) | `tests/unit/multimachine-syncstatus.test.ts:46`; `tests/e2e/multi-machine-lease-split-brain.test.ts:64,147`; `tests/integration/pool-routes.test.ts:60` |
| `getSyncStatus()` never-null docstring + `/health` serializer comment (M10 reconciliation) | `src/core/MultiMachineCoordinator.ts:960-964`; `src/server/routes.ts:2575-2581` |
| syncStatus served on `/health` and `/pool` | `src/server/routes.ts:2579-2581`, `:13564-13580` (also `:13713`, `:13907`) |
| multiMachine config surface (pollFollowsLease / meshTransport / sessionPool / stateSync / seamlessness) | `src/core/types.ts:2274-2561` (`:2388`, `:2408`, `:2352`, `:2446`, `:2454-2560`) |
| Transport security: `session-status` is a signed, replay-guarded, RBAC'd MeshRpc read | `src/core/MeshRpc.ts:241-296` |
