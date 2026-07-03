---
slug: machine-coherence-guard
title: Agent Machine-Coherence Guard — pool-wide version + flag-skew detection, one alarm (Roadmap 4.1, F4/P0-1)
status: draft — round-5 revision (round-1..4 findings folded; awaiting round-5 convergence review)
author: echo
eli16-overview: machine-coherence-guard.eli16.md
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
constitution: Cross-Store Coherence Is an Invariant (machine-registry roles vs live lease/heartbeats answer the same "who is awake" question with no declared agreement check — this spec declares and mechanizes it); A Dark Feature Guards Nothing (the F4 audit named this pattern verbatim — G3 covers guards, nothing covers seamlessness flags); Bounded Notification Surface (ONE episode-scoped attention item, never per-heartbeat or per-flag — and §4 names its OWN brakes normatively, because the universal topic budget does NOT cover this path); Structure beats Willpower ("both machines manually equalized" is willpower; the guard is structure); Agent Proposes, Operator Approves (the §4.2 alarm proposes a fix the agent performs on approval — it never walks the operator into config surgery)
lessons-engaged: "P17 (ONE deduped attention item per skew episode — §4); P19 (episode latch + bounded escalation + recurrence damper + per-day cap that gives up loudly — §4.3, §4.4, §4.5); F4 finding family (dev-gate asymmetry silently halves a cross-machine guarantee with no alarm — §1); P0-1 (fleet version coherence has no owner — §1, §8); Verify the State, Not Its Symbol (awakeMachineCount must derive from live lease observations, not last-written registry role rows — §5; and the guard's own comparison universe is flagged when it shrinks — §3.3); the #930/A2/WS2.1/seamlessnessFlags narrowing-return class (the new advert field joins the SESSION_STATUS_ADVERT_FIELDS ratchet so the receive path cannot silently drop it — §3.2); the seamlessnessFlags/posture carry-forward pattern (a sparse liveness beat must not erase a peer's last advert — §3.2, now with an explicit staleness bound so carry-forward can never impersonate freshness); #1001 anti-mechanism (enabled OMITTED from shipped config, resolved via resolveDevAgentGate; registered in DEV_GATED_FEATURES — §7); the partial-config-PATCH clobber hazard (the one-level-deep merge wholesale-replaces nested objects — the 2026-06-11 sessionReaper remediation incident, documented at GUARD-POSTURE-ENDPOINT-SPEC.md §2.5; the agent-performed fix writes FULL config blocks through the atomic write funnel, never a partial nested PATCH — §4.2/§4.2.1)"
earned-from: "2026-07-02 live test-as-self matrix, finding F4 (docs/audits/test-as-self-matrix-2026-07.md, echo agent home): the same agent's two machines resolved ws13PinReplicate differently (Laptop developmentAgent:true → LIVE; Mini config lacked it → DARK), so an NL cross-machine move was acked to the user and then silently never actuated — pinState:pending forever, no alarm. Repaired in-session by hand-editing the Mini's config; the CLASS stayed open. Same audit: awakeMachineCount:0 on /health while both machines were online and the Mini held the lease (P0-1 telemetry incoherence, reproduced live on v1.3.722)."
roadmap: "instar-two-goal-roadmap-2026-07 §5 Phase 4 item 4.1 — 'Agent machine-coherence guard: pool-wide version + seamlessness-flag skew detection → ONE attention item; fix awakeMachineCount telemetry; then updater coordination (fleet version owner)'. Live proof: 'Deliberately skew a flag on one machine → alarm within one heartbeat cycle; matrix transfer scenario passes with zero manual config surgery.' Honesty note (Frontloaded Decision D2): at the shipped default flagConfirmTicks:2 the acceptance clause is restated as '≤ 2 presence-pull cycles (≤ 90s)'."
---

# Agent Machine-Coherence Guard (roadmap 4.1) — round-5 revision

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
  gets ONE consolidated alert.) **Guarantee stated honestly (R2-M2, R3-M3):**
  exactly one item under a coherent pool view; under a DEGRADED view
  (partition, one-sided HTTP degradation, the ≤ `advertStaleMs` disagreement
  window around a posture/lease transition, a raise-silent raiser) the surface
  may briefly hold bounded, honestly-marked duplicates — each cross-referencing
  the other — which converge back to one item via the §3.4 row-identity
  reconciliation rule where both sides can observe each other, and on the
  BLIND side of a one-directional degradation degrade to a SUSPENDED-quiet
  duplicate (§4.3's can't-verify suspension — open but silent, clocks paused)
  that reconciles when fresh adverts return. Never dueling loudly for the
  skew's life.

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
content-scrub):** ≤ 64 entries, key ≤ 64 chars, value ≤ 32 chars; the
fixed-fields+flags portion ≤ 2 KB serialized and the §3.2 alarm marker gets
its own ≤ 1.5 KB sub-budget (whole block ≤ 3.5 KB; the sub-budgets are
measured on the COMBINED serialization, so JSON structural join bytes are
inside the ratchet's measurement, never an unaccounted overflow — R4-L4). **The BYTE bounds are the
binding limits (R3-N1):** 64 maximum-length entries alone would exceed 2 KB —
the entry-count cap is a secondary sanity bound, and a coherence-flag addition
can trip the byte ratchet well below 64 entries (that is the ratchet doing its
job, detected at build time, never at runtime clamp-rejection). Values come
only from the local manifest's resolvers — never free text, never secrets,
never paths.

**Manifest maintenance guards (N5):**
- A build-time **manifest-size ratchet test** fails the build if the manifest
  exceeds 64 entries or the serialized reference advert — INCLUDING a
  worst-case alarm marker (72 row hashes, §3.2) — exceeds the byte bounds
  above; organic growth can never silently push every machine's advert into
  clamp-rejection (which would kill the guard pool-wide).
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
  beatSeq: number;              // sender-side monotonic advert generation (M5; FORENSIC-ONLY — resets on restart, never a freshness check; R2-L1)
  flags: Record<string, string>; // manifest-resolved effective values, clamped
  alarm?: {                     // present iff THIS machine holds an OPEN local machine-coherence item (R2-M1/M2)
    episodeId: string;          // the holder's own local episode id — N4 format, clamped /^mc-\d{1,29}$/ (R3-N9)
    rowIdentityHashes: string[]; // PER-ROW truncated hashes (16 hex each) of the item's CURRENTLY-CONFIRMED
                                 // §3.3 row identities, sorted, clamped ≤ 72 entries (≥ any ratchet-passing
                                 // manifest's row count) — a LIST so coverage is an INTERSECTION test (R3-M4/N2)
    rowsTruncated?: boolean;     // receive-clamp honesty ONLY — structurally unreachable for a legal manifest;
                                 // NEVER grants coverage (R3-M4: an unlisted row is NOT covered)
  };
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
- **The `alarm` marker (R2-M1/M2):** present on a machine's advert iff that
  machine currently holds an OPEN local `machine-coherence:*` attention item
  it SUCCESSFULLY RAISED (as episode owner OR taker); recomputed each beat
  from local episode state, dropped the beat after the item resolves. **The
  marker keys on item-RAISED, never on episode-open (R4-M1):** the episode
  file records an explicit `itemRaisedAt` stamp, written only when
  `createAttentionItem` returns SUCCESS, and marker emission reads THAT stamp
  — never the episode's mere existence. The episode opens on confirmation
  (§4.1) BEFORE the §4.2 raise, and the advert ships over the mesh while the
  item ships over Telegram — so keying the marker on episode-open would let
  a live-evaluator/dead-adapter machine advertise phantom coverage for an
  item that never reached the operator, standing every standby down for the
  exact dead-adapter fault the §3.4 fallback exists to close. A machine
  whose raise FAILED (or has not happened yet) advertises no covering
  marker; its rows read as uncovered, the fallback fires, and a standby
  raises through its own live adapter. **Emission rides the UNCONDITIONAL
  advert path and reads the retained episode file directly (R3-N3):** a
  machine whose guard was disabled mid-episode (§4.6) keeps advertising the
  marker for its retained open item — its `itemRaisedAt` stamp was set
  before the disable, so the item stays pool-visible and reconcilable while
  the guard is dark. It is the
  pool-visible "the alarm actually exists" signal that §3.4's raise-liveness
  fallback and duplicate reconciliation key on — carried on the SAME advert,
  so it needs no new channel and inherits the clamp, carry-forward, and
  staleness rules of the block it rides in. **Content-freshness (R3-N2):**
  the marker enumerates the item's CURRENTLY-CONFIRMED rows — a row that
  individually clears leaves the marker on the next beat, so a fresh advert
  can never assert coverage of rows its holder no longer confirms.
  `rowIdentityHashes` is content-free (per-row truncated hashes over N1
  row-identity keys — machine ids + clamped value classes, no free text) and
  is a LIST deliberately: coverage checks are INTERSECTION tests, so two
  machines whose confirmed row sets differ slightly still recognize each
  other's alarms (a single set-level hash would read any set difference as
  "not my alarm" — a false raise-silence). **Overflow fails toward RAISING
  (R3-M4 — reversed from the round-3 draft, which had it backwards):** an
  UNLISTED row is NOT covered, everywhere — a truncated marker never grants
  universal coverage (that direction lets a 1-row+flag marker, legitimate or
  forged, suppress every alarm pool-wide — the §0(a) cardinal sin). The
  clamp (72) is ≥ any ratchet-passing manifest's possible row count (≤ 64
  flag rows + a handful of version/protocol/manifest-class rows), so
  `rowsTruncated` is structurally unreachable for a legal manifest; a marker
  that arrives truncated anyway is surfaced LOUDLY through the same
  cannot-verify path as `advert-rejected` ("coherence alarm marker overflow —
  cannot verify coverage"). The worst case this direction buys is a bounded
  DUPLICATE that reconciliation collapses; the old direction bought silence.
  The N5 size-ratchet's reference advert includes a worst-case marker so the
  byte bounds hold with the alarm present (R3-N1).
- **Peer pull:** added to `PeerCapacity` AND to `SESSION_STATUS_ADVERT_FIELDS`
  (`src/core/PeerPresencePuller.ts:101-109`) so the existing wiring-integrity
  ratchet — built precisely because four prior advert fields were silently
  dropped by the receive-side narrowing — covers it from day one.
  **Second enumeration named (R2-N1):** the ratchet covers only
  `narrowSessionStatusToPeerCapacity`; the field must ALSO be added to the
  hand-maintained field spread in `pullOnce`'s `recordHeartbeat` call and its
  deps type (`src/core/PeerPresencePuller.ts:254`, `:172`) to reach registry
  storage — forgetting it there passes the ratchet and silently drops the
  field (the #930 class, potential 5th instance). Both additions are named
  build work, pinned by a pull→registry ROUNDTRIP test asserting every
  `SESSION_STATUS_ADVERT_FIELDS` entry survives from a fetched `PeerCapacity`
  into `MachinePoolRegistry` storage.
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
  **`beatSeq` receiver semantics (R2-L1):** forensic-only. Receivers never use
  it as a monotonicity or freshness check — a sender restart resets it to 0,
  so a naive monotonic gate would reject every fresh post-restart advert.
  Freshness is exclusively the receiver-stamped `advertReceivedAtMs`; `beatSeq`
  exists for jsonl forensics (did the sender rebuild between two receipts?).
- **Receive-side clamp — NEW BUILD WORK (M4).** No receive-side clamp exists
  today: `narrowSessionStatusToPeerCapacity`
  (`src/core/PeerPresencePuller.ts:122-150`) and
  `MachinePoolRegistry.recordHeartbeat` (`src/core/MachinePoolRegistry.ts:209-278`)
  store peer objects verbatim; the cited posture-ingestion doc comment
  (`src/core/types.ts:2075-2078`) documents identity-binding + receipt-age
  only. This spec DELIVERS the clamp, in the puller's narrowing step:
  type-clamp on receive (string lengths per §3.1 bounds, entry count ≤ 64,
  numeric `protocolVersion`/`beatSeq`, `alarm.episodeId` matching
  `/^mc-\d{1,29}$/` — the N4 format, NOT length-only: the id is rendered into
  operator-facing appends and the L2 exposure invariant forbids peer free
  text there, so a non-matching id drops the MARKER (incrementing the
  `clampRejections` counter with a jsonl row naming the marker-drop reason —
  a forged-episodeId campaign is visible on the status route, R4-N7; the
  advert's other fields stand) and appends render only clamp-passed ids
  (R3-N9) —
  `alarm.rowIdentityHashes` ≤ 72 entries of exactly 16 lowercase hex each +
  boolean `rowsTruncated`, whole block per the §3.1 byte budgets), keyed on the
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
    worst-case alarm latency ≈ 60–90s. **Consecutive means consecutive
    (R2-L3):** a row's confirmation counter counts only ticks in which every
    machine participating in that row was PRESENT in the comparison set; a
    tick where a participant drops out (offline / `unknown` / `advert-stale`)
    RESETS the counter — never non-consecutive accumulation. (A skewed peer
    that is never online for `flagConfirmTicks` consecutive ticks never
    confirms — acceptable: its liveness problem has existing owners.) Confirmation rationale, corrected per
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
- **Single-machine: strict no-op.** The comparison set is `{self}` — self is
  always comparable, so `machinesCompared: 1`, which is exactly what the §7
  status route reports (R2-N6: the two sentences describe one behavior); the
  evaluator short-circuits at fewer than 2 members and returns an empty
  verdict before any state is touched.
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
  persists, the currently-elected raiser takes over: it raises its OWN item —
  under its OWN local episodeId (episode state is machine-local; the taker
  cannot know, and does not need, the lost owner's id) — whose body opens
  with "taking over this coherence alarm from <nickname> (no longer able to
  alarm)" and cites the SKEW ROWS (which the taker knows from its own
  evaluation) as the cross-machine identity; when the lost owner's last
  retained advert carried an `alarm` marker, its episodeId is cross-referenced
  as a courtesy. Takeover is latched once per (row-identity set, lost owner) —
  never a per-tick stream — and the latch RE-ARMS when that owner returns and
  its duplicate reconciles (R3-N4: a flapping owner's second departure gets a
  second takeover, not silence; re-arm chatter is bounded by §4.5's
  per-episode append budget). When the old owner returns still holding its
  open local item, the duplicate converges via the reconciliation rule below.
  Takeover/fallback latch records and fallback silence clocks follow the
  R2-L3 lifecycle (R3-L1): dropped when their row leaves the confirmed set
  and on episode close — never unbounded accumulation.
- **Raise-liveness fallback — a live-advertising raiser that raises nothing
  loses the election (R2-M1):** candidacy keys on the advert's `guard:'live'`
  field, which `refreshPool` emits INDEPENDENTLY of evaluator/alarm-path
  health — so a machine whose evaluator is wedged or whose attention/Telegram
  adapter is dead would otherwise capture the election and raise nothing,
  forever, while every standby stands down (one fault defeating property (a)).
  The fallback: a standby that has LOCALLY confirmed a skew and computes
  `raiser !== self` starts a silence clock per row-identity set; if after
  `raiserTakeoverTicks` (the same knob as owner-loss) NO machine's fresh
  advert carries an `alarm` marker whose LISTED `rowIdentityHashes` intersect
  the standby's confirmed rows (an unlisted row is NOT covered — R3-M4;
  truncation never grants coverage), those uncovered rows are raise-SILENT
  and the fallback fires, raising an item that covers the UNCOVERED confirmed
  rows only. **"Raise-silent" is defined precisely (R3-M2 — the round-3
  wording was ambiguous between permanent silence and dual-raise):** a
  machine is classified raise-silent IFF it (a) IS the current election
  result (the elected raiser — never a mere standby: a standby holding no
  marker is correct behavior, not silence), (b) advertises `guard:'live'`,
  and (c) has emitted no covering marker for `raiserTakeoverTicks` since the
  local confirmation. The subtraction is ITERATIVE for cascades: subtract the
  raise-silent elected raiser, recompute the election over the remainder; the
  new result gets its OWN `raiserTakeoverTicks` deadline (counted from when
  it became the result) before it too can be classified raise-silent. A
  standby steps up IFF it is the current election result over the remainder —
  every machine computes the same subtraction from shared inputs, so exactly
  one steps up (the 3-machine walk: A elected+wedged → after the deadline
  only A is subtracted; the election over {B, C} names B; B steps up, C
  computes the same result and defers to B by machineId order WITHOUT needing
  to see B's marker first). The takeover body opens honestly: "the machine
  that should have raised this (<nickname>) hasn't been able to — stepping
  up." Latched once per (row-identity set, silent raiser), re-armed per
  R3-N4 above. If the original raiser was merely slow and its item appears
  later, the duplicate converges via the reconciliation rule below. **Threat-model honesty:** this
  closes FAULTS — the wedged evaluator (no confirm → no episode → no marker)
  AND the dead attention/Telegram adapter or crashed alarm path (confirm +
  episode-open but the raise FAILS → no `itemRaisedAt` stamp → no covering
  marker, per R4-M1 — the advert keeps flowing because emission is
  unconditional, but coverage requires raise-SUCCESS, so adapter death can
  never buy phantom coverage). A Byzantine own machine that FORGES an
  `alarm` marker without holding a raised item defeats any self-reported
  liveness — accepted residual, consistent with the mesh trust model
  (machine-auth-verified own machines are trusted; a compromised own
  machine already defeats far stronger invariants than one alarm). The
  operator's manual cross-check exists today: `GET /attention?scope=pool`
  (`src/server/routes.ts:12521-12644`) shows which machine actually holds the
  item.
- **Duplicate-item reconciliation — ONE rule, keyed on row identity, never on
  episodeId (R2-M2):** all duplicate paths (owner-loss takeover, raise-silence
  fallback, dual-open under a degraded view, split-brain heal) converge
  through one rule. Cross-machine episode identity is the N1 skew-row identity
  set — episodeIds are machine-local and differ by construction. The channel
  is the advert `alarm` marker (§3.2): every machine holding an open item
  advertises it. The rule: a machine holding an OPEN local machine-coherence
  item that OBSERVES (fresh, clamp-passed advert) another machine's `alarm`
  marker with an INTERSECTING row-hash set applies the deterministic survivor
  pick — **the holder with the lexicographically smallest machineId survives
  (R3-L5: the pick is computed from MARKER DATA ALONE — the round-3 draft's
  elected-raiser preference read each holder's own lease view, so two holders
  straddling a lease transition could each compute "I am survivor"; machineId
  order is lease-view-independent and converges in one mutual observation).**
  Every non-survivor resolves its own item `superseded-by-takeover` with ONE
  append cross-referencing the survivor's episodeId (known from its marker)
  and INVALIDATES any pendingFix it carries (R3-M6 — §4.2.1). While views
  still disagree (bounded by `advertStaleMs`) both items persist, each
  honestly cross-referencing the other. **The blind side of a
  one-directional degradation converges to QUIET, not to a duel (R3-M3):**
  when A can pull B's adverts but B cannot pull A's, B never observes A's
  marker — but by the same token A is `advert-stale`/`unknown` from B's view,
  which SUSPENDS B's episode under §4.3's can't-verify rule (item open but
  silent, clocks paused). The duplicate persists only as a suspended-quiet
  item bounded by the degradation's life; when fresh adverts return, the
  reconciliation rule fires and one item survives. **Byzantine honesty
  (R3-N10):** a forged covering marker from a compromised own machine can
  ACTIVELY extinguish a real, already-raised item (the non-survivor
  resolves) — not merely suppress a future one. This is the same accepted
  residual as the fallback's (machine-auth-verified own machines are
  trusted; a compromised own machine defeats far stronger invariants),
  enlarged here and named rather than hidden; the operator's cross-check is
  `GET /attention?scope=pool` (which machine actually holds an item), and v1
  deliberately does NOT add a cross-machine item-existence probe to the
  evaluator path. **Partial overlap is convergent, not loopy:**
  the non-survivor's whole item resolves; any of its confirmed rows the
  survivor's marker does NOT cover simply re-enter the raise-liveness
  fallback path and re-raise as a DISJOINT item — whose marker no longer
  intersects the survivor's, so no reconcile/re-raise cycle exists. In the
  normal case (both machines evaluate the same shared adverts) the row sets
  are identical and one item simply survives. This rule — not sticky ownership — governs
  whenever TWO items are open for one skew; sticky ownership governs the
  ordinary one-item case (the lease moving never orphans or duplicates an
  item). Dual-open WITHOUT a partition (two machines each computing
  `raiser === self` inside the same confirm window — reachable for up to
  `advertStaleMs` around a guard-posture/lease transition) is closed by the
  same rule the moment either side's next fresh advert lands; the
  one-directional-degradation dual-open (git beats keeping both online while
  one HTTP direction is down) closes via the R3-M3 suspension above until
  fresh adverts return, then the rule.
- **Split-brain honesty:** during a genuine network partition, each side's
  election sees only its own partition — two raisers can coexist until the
  partition heals (each honestly alarming about the machines it can see;
  the partition itself is the rope-health/split-brain machinery's alarm to
  own, and §2.4's `splitBrainItemOpen` gate already suppresses secondary
  monitors during it). On heal, the reconciliation rule converges the surface
  back to one item; every non-survivor resolves `superseded-by-takeover`.

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
`mc-<openedAtEpochMs>`, minted by each machine for its OWN local episode view
(episode state is machine-local — §3.4 posture table). The id needs no
cross-machine coordination because it is never the cross-machine identity:
machines match episodes by the N1 skew-row identity set (§3.4's
reconciliation rule), and a takeover item is simply the taker's own episode —
its own id — cross-referencing the predecessor's id when known from its last
advert `alarm` marker (R2-M2; this supersedes the round-2 `-t<n>`-suffix
scheme, which assumed the taker could know the lost owner's id).

**State-file write cadence (R2-N3):** the episode state file is written on
state TRANSITIONS only (open / item raised (`itemRaisedAt`, R4-M1) / row join
/ suspend / resume / reopen / close / recurrence-bookkeeping change /
pendingFix change) — never per tick, and flap-class transitions go
jsonl-only while latched (§4.5, R4-N5).
Confirmation and resolve tick COUNTERS are in-memory only: a restart resets
them, delaying confirmation or resolution by at most one full window (≤ 90 s
at defaults), absorbed by the N8 warm-up — the alternative (persisting
counters) would rewrite the file every 30 s for the life of an unconfirmed
skew.

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
  belt-and-suspenders over a platform backstop. The platform-wide
  `origin:'system'` budget exemption itself is a standing P17 gap OUTSIDE
  this spec (any HIGH/system source elsewhere can still flood the topic-birth
  chokepoint); named as a tracked platform follow-up, not this spec's to fix
  (R2-L6). <!-- tracked: platform/p17-system-origin-topic-budget -->
- **Body contract (M9 — Agent Proposes, Operator Approves; Operator-Surface
  Quality):** the body leads with plain-language impact and a fix the AGENT
  performs on approval — never a config recipe the operator must execute:
  1. **Impact first, plain language:** "My two machines have drifted apart —
     **the laptop** and **the mini** aren't running as the same me:
     conversation-moves between machines will silently fail." (The manifest
     entry's `guarantee` line, rendered per skew row, by nickname.)
  2. **A complete proposed fix, approve-to-execute:** the proposal ALWAYS
     names the target machine, the target value, and what it matches — the
     direction is never implicit (§4.2.1-ii) — and its execution promise is
     CASE-HONEST (R3-M1: the round-3 body promised "restart that machine's
     server", a remote actuation §4.2.1-iv forbids — a direct
     self-contradiction, removed). In the approve-line, `<flag>` renders as
     the PLAIN-LANGUAGE feature name (the manifest entry's `guarantee`
     framing — "the setting that makes conversation-moves work"); the dotted
     config key stays in point 3's secondary technical block (R4-L2 — M9's
     plain-language-first intent applies to the approve-line too). When the
     divergent machine IS the raiser (the machine speaking): "Reply **fix
     it** and I'll set `<flag>` to `<target value>` here on <nickname> to
     match <the rest of the pool>,
     then restart my own server — a ~30-second blip; I currently hold the
     serving lease, so the restart hands serving to <peer nickname> for that
     blip (a failover, named, not a surprise)" — the lease clause rendered
     only when true. When the divergent machine is ANY OTHER machine: "Reply
     **fix it** and I'll apply `<flag>` = `<target value>` on <nickname>
     from my own hands there — no remote config-write exists, so I'll
     confirm here when it lands (and tell you loudly if it doesn't within a
     few minutes)." Either way: "or reply **leave it** and I'll keep this
     episode open without further nagging" — an explicit "leave it" records
     an operator-acknowledged episode that SUPPRESSES the §4.4 escalation
     append (the item stays open, jsonl continues — R3-N7). **The ack is
     DURABLE (R4-N2):** it lives in the episode state file
     (transition-written on set), survives restarts and suspend/resume — a
     restart between "leave it" and the 24 h mark can never fire the
     escalation the operator suppressed — and is CLEARED on a genuine §4.5
     recurrence re-open (the divergence came back; one fresh nag is
     honest). The agent — not
     the operator — performs the config write on approval, and when it does,
     it writes the FULL nested config block the key lives in
     (read-modify-write of the whole top-level object — e.g. all of
     `multiMachine.seamlessness` for the F4 pair), NEVER a partial nested
     PATCH: the one-level-deep config merge erases sibling keys on a partial
     block (the documented `PATCH /config` clobber hazard) — a skew "fix"
     must never create new skew. Authority, direction, mechanism, and
     failure semantics are pinned in §4.2.1.
  3. **Technical detail last, in a secondary block:** dimension, key,
     per-machine effective values, manifestHash — for the operator who wants
     it. NO raw `PATCH /config` command lines, NO dotted-config-key-first
     framing anywhere in the body.
- **Exposure invariant (L2, stated normatively):** alarm rows render ONLY
  local-manifest-intersection keys and clamp-passed enum value classes — never
  a peer's free text, never paths, never anything outside the §3.1 clamp
  alphabet. (The body does reveal which safety flags are dark/dry-run on which
  machine, to the operator-only attention surface — the same information
  `GET /guards` already serves that operator.) **The one free-text field the
  body renders is the machine NICKNAME (R4-L1):** nicknames are
  registry-sourced display labels the mesh already renders on `/pool`,
  `/guards`, and `machine list` — they inherit that pre-existing,
  registry-wide identity-field trust (display-only, own-machine-set), are
  ESCAPED at the operator-surface rendering boundary, and are never used as
  identity (N1 keys on machineId). The invariant is honest about this one
  inherited exception rather than silently carrying it.

### 4.2.1 The approved fix — principal, direction, mechanism, failure (R2-M3)

The fix is the ONLY action anywhere in this build. Five decisions, each pinned:

- **(i) Approval binds to the VERIFIED operator and to ONE proposal.** The
  "fix it" reply is honored only when the AUTHENTICATED sender uid matches
  the topic's verified operator binding (`TopicOperatorStore`,
  `src/users/TopicOperatorStore.ts:57`) — the exact reply-in-topic principal
  rule the scope-accretion ratifier already enforces
  (`src/core/ScopeAccretionRatifier.ts:185-186`: `getOperatorUid(topicId) ===
  senderUid`, else the message is ignored; Know Your Principal). Mechanically
  the flow follows the ratifier's proven shape (proposal → server-authored
  statement → confirmation bound by the message-id chain, display-integrity:
  what was shown is byte-identical to what executes): the raiser records a
  `pendingFix` in its episode state — episodeId + key + target machine +
  target value + the proposal message id + a hash over that tuple — and a
  reply confirms ONLY that exact recorded proposal. **Reply recognition
  boundary (R3-N5):** recognition of the reply lives in the CONVERSATIONAL
  agent handling the topic (the sentinel stays Tier-0 — no LLM anywhere in
  ITS path, D17 intact); the message-id chain + the recorded proposal hash
  is the AUTHORITY — nothing executes without matching both; "fix it" /
  "leave it" are the documented convention, not a string gate. **Cardinality
  (R3-N8):** ONE pendingFix at a time per episode — each "fix it" binds
  exactly one proposal; when an episode carries several skew rows, the body
  proposes the first and the rest are proposed after it resolves.
  **Lifecycle completeness (R3-M6, state-scoped per R4-M2):** a pendingFix
  is in one of three states — `proposed`, `approved-holding` (approved, write
  not yet performed), or `executing-verifying` (write + restart done, verify
  window open). The INVALIDATION rule applies to the two NOT-YET-EXECUTED
  states only: a `proposed` or `approved-holding` pendingFix is INVALIDATED
  by any skew-set change (a row joins, clears, or changes value class), by
  ANY §4.3 close (including `superseded-by-takeover` — reconciliation
  invalidates the non-survivor's pendingFix), by suspension, and by a §4.6
  corrupt-file re-baseline (a fresh episode carries no pendingFix — R3-L3).
  **When suspension invalidates an `approved-holding` fix, the suspension
  note NAMES it** ("the fix you approved is paused — <nickname> is
  unverifiable/offline; I'll re-propose when it returns") — never a silent
  lapse the operator discovers later (R4-M2's surfacing half). An
  `executing-verifying` fix is NEVER invalidated by suspension — the write
  already happened, a durable side-effect that cannot be un-approved;
  suspension instead PAUSES its verify clocks (see (v)), and the verify
  resumes on the participant's return. A reply that binds to an invalidated
  proposal is REFUSED with ONE honest note ("that proposal lapsed — <why>";
  where the skew persists under a surviving item it is re-proposed fresh
  there) — never silently executed against a pool state the operator no
  longer sees, never silently dropped. **Re-proposal cadence (R4-N1):**
  re-proposals — the post-failure retry and the next row of a multi-row
  episode — are rendered IN-PLACE in the item body (an item edit, not a new
  append) and are gated on the operator's NEXT explicit approval; there is
  never an autonomous retry stream. Fix execution is idempotent, and
  single-flight is enforced at two pinned points (R4-N4 — the round-4
  "pool-wide" phrasing overclaimed): (a) the surviving-item holder's own
  pendingFix substate (one server, one funnel — a second approval while one
  execution is in flight or verifying is refused-with-note), and (b) the
  DIVERGENT machine's own local atomic funnel, whose restart is gated on
  ACTUAL config change — a no-diff write performs NO restart. Together:
  never two CONFLICTING writes (the atomic funnel serializes; idempotent
  content); in the interleaved pre-reconciliation blind-side window (two
  holders that cannot yet see each other, both approved for a third
  machine) a REDUNDANT no-op write is possible and a redundant restart is
  prevented by the no-diff gate — bounded by idempotency + skew-set
  invalidation, stated honestly rather than claimed away.
- **(ii) Direction is canonical and always named.** Equalize toward the
  POOL-MAJORITY effective value among compared machines; when no majority
  exists (the 2-machine pool — the common case), toward the
  SERVING-LEASE-HOLDER's value. The proposal names the target machine and
  target value in plain words ("I'll set X on the mini to match the laptop")
  — a one-word approval can never flip a value in an unstated direction. F4
  is fixable in two directions (set the Mini live OR the Laptop dark); the
  canonical direction is a PROPOSAL default, not a limit — the operator can
  instruct the opposite conversationally, which starts a fresh proposal
  round, never a silent reinterpretation of "fix it". **Value translation
  (R3-N6):** the write targets the concrete EXPLICIT config override that
  YIELDS the target effective value — e.g. equalizing the F4 pair (both
  configs OMIT the key; the divergence is rooted in `developmentAgent`)
  writes `ws13PinReplicate.enabled: true` explicitly into the divergent
  machine's block — never the resolved enum as a string, and never the
  excluded root gate (iii): the fix equalizes the ALARMED key by explicit
  override, leaving the excluded switch untouched.
- **(iii) Two row classes are NEVER auto-proposed.** `developmentAgent` (the
  F4 root switch — flipping it flips EVERY omitted dev-gated resolution on
  that machine at once, far beyond the alarmed key) and the guard's own
  posture row (`monitoring.machineCoherence` — flipping the guard live is a
  §7 graduation-ladder action, not an equalization). For these rows the body
  renders a MANUAL decision block instead: it names the asymmetry and asks
  which way the operator wants it; the agent performs nothing until a
  specific instruction. (The naive "equalize" would happily propose
  rewriting the F4 root flag itself — the exact blast radius this exclusion
  stops.)
- **(iv) The write is ALWAYS local to the divergent machine; no mesh
  config-write exists or is added — and v1's MECHANIZED execution is scoped
  to divergent == raiser (R3-M1).** `PATCH /config` is per-machine and no
  cross-machine config-write relay exists in the deployed code — and this
  spec deliberately does not add one (a remote config-write is action-bearing
  mesh authority needing its own analysis, exactly like Phase 2's updater —
  §8). Exactly two execution cases, both pinned:
  - **Divergent == raiser (mechanized):** the raiser's own SERVER process —
    which detected the approval at its receive path (i) — performs the write
    against its own config and restarts itself. The write goes through the
    atomic config-write funnel (`writeConfigAtomic` — re-read → mutate →
    tmp+rename, `src/core/BootSelfKnowledge.ts:112`, the funnel routes.ts
    already uses at `:18898`), NOT the raw `PATCH /config` body's
    readFileSync→merge→writeFileSync (neither atomic nor locked — R3-N12);
    the full-block read-modify-write is last-writer-wins against a
    concurrent config writer, an accepted named residual (PostUpdateMigrator
    interaction is add-missing-only existence-checked deep-merge and cannot
    clobber the fix). The outcome (`fixesApplied`/`fixesFailed` + jsonl row)
    is written WRITE-AHEAD — recorded durably BEFORE the restart is
    initiated — so the handoff survives the restart. **The invocation
    surface + restart primitive, named (R4-L8/R4-N6):** the ratifier-style
    reply match invokes the server's own internal fix-execution action
    in-process (the same receive-path handler that matched the reply — no
    new HTTP surface); the self-restart is write-ahead + PROCESS EXIT under
    the launchd/systemd keepalive supervisor — the same supervisor
    dependency every existing self-restart relies on — NOT a naive
    in-process `restartServer()` call (its launchd path boots out the
    calling process before the bootstrap half can run,
    `src/commands/server.ts:21630`; the lifeline restart-signal pattern,
    `src/core/version-skew.ts:82` `writeLifelineRestartSignal`, is the
    alternative carrier). A
    NON-supervised `instar server` cannot self-restart: on such a host the
    write still lands (write-ahead outcome recorded) and the restart
    degrades to the held/manual path with the honest append — never a
    silent no-restart. **Restart honesty:** when the raiser holds the
    serving lease, its restart is a FAILOVER (serving hands to a standby
    for the blip and may hand back per the F4 preferred-captain
    reconciler), and the (§4.2) proposal says so — never "a blip" on the
    machine in charge.
  - **Divergent == any other machine (held, honestly):** v1 provides NO
    structural cross-machine execution trigger — naming that plainly instead
    of hiding it in "coordinated conversationally" (the round-3 wording;
    Structure>Willpower fails on an unnamed trigger). On approval the
    `pendingFix` HOLDS durably with ONE honest append ("approved — I'll
    apply this from my own hands on <nickname>; I'll confirm here when it
    lands"), and the actual write happens the way any cross-machine task
    does today: the agent acting on that machine through its own session
    there, against its own local config via the same atomic funnel. The
    HOLD is bounded, not open-ended: if the skew row is not observed
    cleared within `2 × fixVerifyTicks` of the approval, the (v) failure
    append fires and the pendingFix clears — the operator is never left
    believing an unexecuted fix landed. The founding F4 topology (divergent
    Mini, dark guard, raiser Laptop) is THIS case in v1: the alarm, the
    proposal, and the approval are fully mechanized; the final write is the
    agent's own hand on the Mini inside a bounded, loudly-verified window.
    A structural cross-machine execution channel is Phase 2's authority
    work (§8), same class as the updater.
  When the divergent machine is offline/asleep the same HOLD applies with
  the reach-honest append ("I can't reach <nickname> — holding; it applies
  when that machine returns"), still bounded by the same verify window from
  approval. In every case the fix never travels as a new mesh write and is
  never silently dropped.
- **(v) Failure is loud, and the episode outlives the fix.** The fix flow can
  NEVER close an episode — closure belongs exclusively to §4.3 (`restored` =
  the evaluator OBSERVES convergence for `resolveTicks`). After an approved
  fix executes, if the write or restart fails, or the skew row has not
  cleared within `fixVerifyTicks` (default **10** ticks ≈ 5 min, counted
  from the divergent machine's first post-restart beat — or, when no
  post-restart beat ever arrives, `2 × fixVerifyTicks` from the approval, so
  a machine that dies in the restart can never leave the fix pending
  forever), ONE honest append
  lands ("the fix didn't take — <write failed / restart failed / skew still
  present>"), the `pendingFix` clears (a retry requires fresh approval), and
  the episode stays open. **Suspension pauses the verify clocks (R4-M2):**
  BOTH the `fixVerifyTicks` tick count and the `2 × fixVerifyTicks`
  wall-clock outer bound EXCLUDE suspended time — exactly as suspension
  pauses resolve-ticks and the escalation clock (§4.3). A skew participant
  sleeping or degrading mid-verify therefore never fires a FALSE "the fix
  didn't take" (the write took; the peer merely left) and never silently
  lapses an executed fix: the verify resumes when the participant returns
  verifiable, and its verdict comes from observed adverts then. Success is
  never claimed by the fix path: only the `restored` close — driven by
  observed adverts — ever says restored, so the operator can never be left
  believing a fix landed that didn't.

### 4.3 Close-reason taxonomy — auto-resolve never lies (M1)

An episode CLOSES only through one of these named reasons; **only `restored`
may claim restoration**:

- **`restored`** — a full evaluator pass over a comparison set that still
  CONTAINS every machine participating in the episode's skew rows finds zero
  skew for `resolveTicks` (default **3**) consecutive ticks. The item is
  PATCHed resolved + ONE resolution note lands on its topic
  ("machine-coherence restored — <keys> now agree across <nicknames>, held
  for <resolveTicks> ticks").
- **`suspended-peer-offline` / `suspended-peer-unverifiable`** — a machine
  participating in the episode's skew leaves the VERIFIABLE set (R3-M3
  generalizes the trigger): it goes offline (nightly laptop sleep — the
  canonical case), OR it stays online but its advert degrades to
  `advert-stale`/`unknown`/`advert-rejected` (the one-directional-degradation
  blind side: git beats keep it online while the HTTP advert path is down —
  the skew's current truth can no longer be verified). The episode does NOT
  resolve: it SUSPENDS — the item stays open, ONE short append notes the
  honest reason ("the divergent machine (<nickname>) went offline — holding
  this open; I'll re-check when it returns" / "…is online but I can't read
  its coherence card — holding"), the escalation clock (§4.4) PAUSES,
  resolve-tick counting stops (a pass whose comparison set lost the skew
  participant counts toward NOTHING — M1's changed-set rule), and an
  `executing-verifying` pendingFix's verify clocks PAUSE with them (R4-M2 —
  §4.2.1-v: one paused-clock list, no omissions; a `proposed`/
  `approved-holding` pendingFix is instead invalidated WITH the named note,
  §4.2.1-i). Suspend/resume transition appends ride the §4.5 per-episode
  append budget (R3-M5) — a flapping boundary latches to jsonl-only, never a
  per-flap stream — and ONE budget slot is RESERVED for the first
  suspend/resume transition per window, so a row-churn storm can never crowd
  out the suspend note that changes escalation behavior (R4-L6). When the
  peer returns verifiable: skew still present → the SAME episode resumes
  silently (same item, no new topic, confirmation not re-required for
  already-confirmed rows); skew gone → close `restored` via the normal
  resolve-ticks path. Without this, one persistent skew on a sleep-cycled
  machine would mint a false "restored" marker plus a fresh HIGH topic per
  day, indefinitely — and a blind-side duplicate would duel loudly for the
  degradation's life.
- **`expired-peer-gone`** — a suspended episode whose participant has stayed
  offline past `suspendedEpisodeExpiryMs` (default **7 days**) closes with
  this honest marker ("the divergent machine never came back — closing; a
  fresh divergence will open a new episode"). Never rendered as "restored".
- **`superseded-by-takeover`** — §3.4 reconciliation-rule non-survivor.
- **`resolved-after-reenable`** — §4.6 disable/re-enable disposal.
- **`manifest-changed`** (R2-L5) — a manifest-membership REMOVAL landing
  mid-episode (an update retires a key, shrinking the intersection so the
  episode's remaining rows vanish) closes the episode with this distinct
  marker ("<keys> are no longer compared under the new manifest — closing;
  not a restoration claim"). D9's changed-SET rule covers machine-set
  changes; this marker covers KEY-set changes — never rendered as
  "restored".

### 4.4 Escalation only on persistence

If an episode stays open (unsuspended clock) past `escalateAfterMs` (default
**24 h**), exactly ONE escalation append on the existing item's topic ("still
divergent after 24h"). Then silence — bounded, level-triggered, P19. The
episode latch is the `FailureEpisodeLatch` shape
(`src/core/FailureEpisodeLatch.ts:1-60`): signal once per episode, stay quiet
while the condition persists, reset on recovery. Suspension (§4.3) pauses this
clock — an offline peer must not accrue "still divergent" time it cannot fix.
An explicit operator "leave it" (§4.2) SUPPRESSES this escalation append for
the episode (R3-N7) — an operator-acknowledged open episode is not nagged.

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
  jsonl-only + counted on the status route, and ONE final append says
  "coherence is flapping faster than I'll alarm — N further episodes today
  recorded silently; see /pool/machine-coherence" — the P19 give-up-loudly
  pattern, never an unbounded stream and never silent swallowing.
  **Cap-append target pinned (R2-N4):** the give-up note is an append on the
  most-recent episode item's TOPIC — a topic append requires no open item,
  so a resolved/expired most-recent item is fine (nothing is re-opened just
  to speak); if no such topic exists any more, the give-up is jsonl +
  status-route only, honestly counted.
- **Latched flapping mode — re-open appends are themselves bounded (R2-N4):**
  the per-day cap bounds new ITEMS only; a skew flapping inside
  `reopenWindowMs` would otherwise emit a `restored` note + an "it's back"
  append per cycle (~2 messages/2.5 min at defaults) indefinitely on one
  topic. After `flappingLatchReopens` (default **3**) re-opens of the same
  episode within its rolling window, the episode enters LATCHED-FLAPPING:
  further flap transitions are recorded jsonl-only + counted on the status
  route, and ONE append says "this divergence is flapping — recording
  silently until it stabilizes". The latch exits when a close holds past
  `reopenWindowMs` (the next genuine re-open after a stable period speaks
  normally again).
- **Per-episode append budget — EVERY intra-episode transition class is
  bounded (R3-M5):** the reopen latch above keys on episode RE-OPENS only;
  two more per-flap paths existed unbounded in the round-3 draft — a row
  flapping confirm/clear/re-confirm INSIDE a still-open episode (one "row
  joined" append per re-join, ~20-40/hr) and a suspend/resume boundary
  flapping (the spec's own M5 scenario: HTTP adverts flapping while git
  beats hold the peer online — hundreds of appends overnight), on a HIGH
  path with NO platform budget behind it (M2). The bound: ALL intra-episode
  transition appends (row joined/re-joined, suspended/resumed,
  takeover/fallback re-arms) share one rolling per-episode budget —
  `episodeAppendBudget` (default **6** appends per rolling
  `episodeAppendWindowMs`, default **6 h**), with ONE slot RESERVED for the
  first suspend/resume transition per window (R4-L6 — the semantically
  load-bearing note that pauses clocks is never crowded out by cosmetic
  row-churn); past the budget the episode enters the SAME latched-flapping
  mode (one "flapping — recording silently" note, further transitions
  jsonl-only + counted). **The budget is SHARED across all transition
  classes and its latch exit is pinned (R4-N3/R4-L7):** one budget for the
  whole episode — never a budget per class (three classes flapping together
  still produce ≤ budget + 1 appends TOTAL); the latch releases when the
  rolling append count within `episodeAppendWindowMs` falls back below
  `episodeAppendBudget` (an intra-episode latch cannot use the reopen
  latch's close-based exit — the episode never closes). **Latched mode
  bounds DURABLE WRITES too (R4-N5):** while latched, the flap transition
  classes (suspend/resume, row re-join, takeover re-arm) drop to jsonl-only
  INCLUDING the episode state-file write — only latch-enter and latch-exit
  write durably, so durable I/O is bounded by ~the budget per window rather
  than scaling with flap frequency (the durable `suspended` field is
  intentionally stale-until-latch-exit; safe — confirm/resolve/verify
  counters are in-memory + warm-up-absorbed, and jsonl carries the full
  transition history). The §9 burst-invariant test drives the flap classes
  BOTH individually and concurrently and asserts the shared bound.
  (Structural appends outside the flap classes — the §4.4 single
  escalation, the (v) fix-failure append, the cap give-up — are each
  individually latched and do not ride this budget.)
- **Persistence home (R2-N2):** the rolling-24h new-item timestamps, the
  recently-closed row-identity sets (the reopen window's memory), the
  flapping-latch state, the append-budget bookkeeping, and the "leave it"
  operator-ack flag (R4-N2) live IN the durable episode state file (a
  `recurrence` sibling block to the open episode — same atomic tmp+rename,
  same §4.6 corrupt-file handling; the block OUTLIVES episode close so the
  reopen window has memory), NOT in memory. These are the ONLY brakes on a budget-exempt HIGH path (M2), and
  boot-read flag flaps inherently involve restarts — an in-memory
  implementation would reset the brake at exactly the moment it is needed.
  **Rolling-window eviction is lazy (R3-L2):** expired window entries are
  dropped at evaluation time and eviction alone never triggers a state-file
  write — only genuine transitions write (R2-N3 stays true under a flap
  storm; the latch additionally bounds durable writes to ~the budget per
  window).

### 4.6 Corrupt state + disable-mid-episode disposal (N3, N4)

- **Corrupt episode file:** re-baseline without crashing (the GuardPostureProbe
  pattern) — but BEFORE raising anything from the fresh baseline, the raiser
  first ADOPTS-or-RESOLVES any open `machine-coherence:*` attention item it
  holds locally: if the fresh evaluation confirms the same skew, the existing
  item is adopted (updated in place, new episodeId cross-referenced); if not,
  the existing item is resolved with marker `state-rebaselined`. The §4.1
  restart guarantee ("neither re-alarms nor forgets") thereby survives the
  corrupt-file path too — a re-baseline can never mint a duplicate HIGH item
  while the old topic is open. A re-baselined episode carries NO `pendingFix`
  (R3-L3/R3-M6: the fresh episodeId means any pending approval lapsed; a fix
  still wanted is re-proposed).
- **Disabled mid-episode:** the status route 503s (dark posture), the episode
  state file is RETAINED as-is, and the open item stays open for manual ack —
  disabling the guard is not evidence the skew healed, so nothing auto-
  resolves. The retained open item KEEPS being advertised in the machine's
  `alarm` marker (R3-N3 — marker emission rides the unconditional advert
  path and reads the retained episode file, §3.2), so the item stays
  pool-visible and reconcilable while the guard is dark. On a later ENABLED
  boot: if the pool evaluates coherent, the stale item is resolved with
  marker `resolved-after-reenable`; if the skew persists, the retained
  episode resumes.

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
  **Clock assumption, stated (R2-N5):** lease liveness (`expiresAt` vs now)
  is judged on the OBSERVER's clock — a machine with significant clock drift
  misjudges peer-lease expiry and skews its own published count (and thus the
  count half of `splitBrainState`). Mitigation, already in the mesh: the pool
  registry detects per-peer clock divergence and marks a machine
  placement-ineligible after two consecutive divergent beats
  (`clockSkewTransition` / `clockSkewToleranceMs`,
  `src/core/MachinePoolRegistry.ts:63`, `:222-271`; per-machine status
  surfaced at `:281`), and the (i) freshness bound caps how long any one
  misjudged observation can distort the count. The count inherits the mesh's
  existing clock-sanity envelope rather than adding its own.
- **Advisory, never authority (L4/SEC-4, stated here where the data lives):**
  peer lease claims are self-asserted advisory data. The count and a
  `contested` verdict route to dashboards and to the existing human-decision
  attention flow — they NEVER drive an automatic demotion. (Demotion authority
  remains exclusively with the existing strictly-higher-epoch supersede gate
  and the operator "demote machine X?" flow.)
- **Legacy heartbeat mode** (no lease coordinator, or `canPullPeers()` false —
  a git-only mesh): keep the registry-role count, tagged `'registry-roles'` —
  with its staleness now named instead of implied. **No operator rollback
  knob, deliberately (R2-L4):** `'registry-roles'` exists as this automatic
  degrade only, never as a config lever. The old counting shape is the
  documented lie this fix removes; reverting to it is not a supported state.
  (The house precedent for naming a lever — `codexExecJson`,
  `detectInWorker` — is engaged and answered: those levers preserve a working
  alternative; this one would preserve a defect.)
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
  openedAt, ownerMachineId, suspended, reopenCount, flapLatched,
  pendingFix: { key, targetMachineId, proposedAt } | null, skews: [...] } |
  null, counters: { ticks, skewsConfirmed, wouldRaise, raised, reopened,
  resolved, suspended, escalated, takeovers, raiseFallbacks,
  duplicatesReconciled, flapLatches, cappedEpisodes, clampRejections,
  fixesProposed, fixesApplied, fixesFailed, errors } }`.
  Registry First: "are my machines coherent?" is a read, never a guess.
- **Audit log:** `logs/machine-coherence.jsonl` — one row per state
  TRANSITION (skew confirmed / episode open / key joined / suspended / resumed
  / reopened / episode closed(reason) / takeover / raise-fallback /
  duplicate-reconciled / flap-latch entered/exited / fix
  proposed/approved/applied/failed / escalated / error-class change), never
  per-tick rows (the transition-only rule the mesh-coherence live check
  already follows). Written by every evaluating machine (§3.4 posture table).
  **Retention (R2-L2):** the jsonl adopts the house bounded-log posture —
  age-pruned rotation, 30-day retention (the SessionWatchdog `rotateLog`
  shape, `src/monitoring/SessionWatchdog.ts:1128`). Worst-case growth is slow
  (~tens of KB/day) but unbounded is unbounded; every evaluating machine
  writes one, so the bound ships with the feature.
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
    "raiserTakeoverTicks": 10,       // owner lost OR elected raiser raise-silent this long while
                                     // skew persists → takeover / fallback step-up (C1, R2-M1)
    "flappingLatchReopens": 3,       // re-opens within the window before latched-flapping (R2-N4)
    "episodeAppendBudget": 6,        // intra-episode transition appends per rolling window before
                                     // latched-flapping (row re-joins, suspend/resume — R3-M5)
    "episodeAppendWindowMs": 21600000, // 6 h — the append-budget rolling window (R3-M5)
    "fixVerifyTicks": 10             // approved fix must observe the row clear within this, else
                                     // one loud failure append + pendingFix cleared (R2-M3-v);
                                     // a HELD fix (divergent ≠ raiser) is bounded by 2× this from approval
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
- Manifest guards (N5, bounds per R3-N1): the size-ratchet test (>64 entries,
  or the reference advert — INCLUDING a worst-case 72-row alarm marker —
  exceeding the §3.1 byte budgets, fails); the membership drift guard (a
  `multiMachine.*` DEV_GATED_FEATURES entry absent from both manifest and
  exclusion list fails).
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
  exactly one takeover item, latched.
- Raise-liveness fallback (R2-M1, R3-M2, R4-M1): the 3-machine walk — A
  elected + raise-silent, B/C standbys with local confirmation → ONLY A is
  subtracted (a standby holding no marker is never classified raise-silent),
  the election over {B, C} names exactly one, that one steps up and the
  other defers; a cascade (the new result also silent past its OWN deadline)
  → iterative subtraction; the raiser's marker appearing BEFORE the deadline
  → no step-up; the DEAD-ADAPTER walk (R4-M1): a raiser whose evaluator
  confirms and opens an episode but whose `createAttentionItem` FAILS
  advertises NO covering marker (`itemRaisedAt` unset) → the fallback fires
  and a standby raises, while a raiser whose raise SUCCEEDED advertises the
  marker from the stamp (including through a §4.6 guard-disable); the latch re-arms after owner-return reconciliation (R3-N4); a
  marker whose LISTED `rowIdentityHashes` do NOT intersect the confirmed
  rows does not satisfy coverage, and a `rowsTruncated` marker NEVER
  satisfies coverage for an unlisted row (R3-M4 — fails toward raising); a
  truncated marker is surfaced loudly as cannot-verify; the step-up item
  covers only the uncovered rows; silence clocks + latch records are dropped
  on row-clear/episode-close (R3-L1).
- Duplicate reconciliation (R2-M2, R3-M3/L5): two machines each holding an
  open item for the same row set, mutual fresh markers → the survivor pick
  is deterministic from marker data alone (lowest machineId — asserted
  IDENTICAL on both sides mid-lease-transition, R3-L5); every non-survivor
  resolves `superseded-by-takeover` cross-referencing the survivor's
  episodeId AND its pendingFix is invalidated (R3-M6);
  owner-return-after-takeover converges to one item; dual-open under a laggy
  view converges within one tick of the first fresh mutual observation; the
  BLIND side of a one-directional degradation SUSPENDS
  (`suspended-peer-unverifiable`) instead of dueling — quiet, clocks paused,
  reconciles on heal (R3-M3); different row sets → no reconciliation fires;
  a peer's marker with a non-N4-format episodeId → marker dropped + counted,
  never rendered (R3-N9).
- Fix flow (R2-M3, R3-M1/M6/N5/N6/N7/N8): a "fix it" reply from a
  NON-operator sender is ignored (uid mismatch); a skew-set change after the
  proposal invalidates `pendingFix` (a stale approval executes nothing); ANY
  §4.3 close, suspension, supersession, or §4.6 re-baseline invalidates it,
  and a reply bound to an invalidated proposal is REFUSED with one honest
  note (R3-M6); one pendingFix at a time per episode (R3-N8); execution is
  single-flight per (divergent machineId, key) — the dueling-items fixture
  (owner + taker both holding pendingFixes, post-reconciliation) produces
  exactly ONE write + ONE restart (R3-M6), and the blind-side concurrent
  fixture (both approved pre-reconciliation for a third machine) produces
  no conflicting write and NO redundant restart (the no-diff gate — R4-N4);
  the proposed direction is pool-majority, else lease-holder
  value, and the proposal text names target machine + value; the write is
  the concrete explicit override yielding the target effective value, never
  the enum, never the excluded root (R3-N6); `developmentAgent` and
  `monitoring.machineCoherence` rows render the manual decision block, never
  an auto-proposal; divergent == raiser → the server writes via the atomic
  funnel, records the outcome WRITE-AHEAD, then restarts (R3-M1/N12);
  divergent ≠ raiser → `pendingFix` HOLDS with the honest append, no mesh
  write attempted, bounded by `2 × fixVerifyTicks` from approval (R3-M1);
  write/restart failure or row still present past the verify window → one
  failure append, `pendingFix` cleared, episode still open; the MID-VERIFY
  SUSPENSION walk (R4-M2): an `executing-verifying` fix whose skew
  participant sleeps/degrades mid-verify → verify clocks PAUSE (no false
  "didn't take" append, no silent lapse), verify RESUMES on return and
  verdicts from observed adverts; a suspension hitting an `approved-holding`
  fix → invalidated WITH the named "the fix you approved is paused" note,
  never silently; re-proposals render in-place and are operator-gated —
  never an autonomous retry append stream (R4-N1); a no-diff write on the
  divergent machine performs NO restart (R4-N4); "leave it" suppresses the
  §4.4 escalation (R3-N7); the fix path can never transition an episode to
  closed (only §4.3 reasons close).
- Episode lifecycle: open → key joins → close `restored` at `resolveTicks`;
  skew-participant offline → `suspended-peer-offline` (item open, escalation
  clock paused, changed-set passes count toward nothing — M1); peer returns
  with skew → same episode resumes, no new item; peer returns clean →
  `restored`; suspended past expiry → `expired-peer-gone` (never "restored");
  recurrence within `reopenWindowMs` → same item re-opened, no new topic
  (M2); >`maxEpisodeItemsPerDay` → jsonl-only + one loud give-up append (M2);
  the cap give-up append lands on the most-recent item's TOPIC even when
  that item is already resolved, and degrades to jsonl-only when no topic
  exists (R2-N4); `flappingLatchReopens` re-opens → latched-flapping (one
  latch append, further flaps jsonl-only, latch exits after a stable window)
  (R2-N4); the BURST-INVARIANT test (R3-M5, shared-budget per R4-N3): a
  participant flapping suspend/resume ×50 and a row flapping confirm/clear
  ×50 inside one open episode — run INDIVIDUALLY and then CONCURRENTLY (all
  classes in one episode) — produce ≤ `episodeAppendBudget` + 1 appends on
  the topic TOTAL per run (the +1 is the single latch note; a per-class
  budget implementation fails the concurrent case), everything else
  jsonl-only; the reserved suspend/resume slot is honored (a row-churn
  storm exhausting the budget still admits the first suspend note — R4-L6);
  while latched, flap transitions trigger NO episode state-file write —
  only latch-enter/exit write durably (R4-N5); the "leave it" ack survives
  a restart and suppresses the escalation after it, and is cleared on a
  recurrence re-open (R4-N2);
  recurrence/cap/latch/append-budget bookkeeping SURVIVES a restart (durable
  in the episode state file, outliving episode close) while confirm/resolve
  tick counters do NOT (reset absorbed by warm-up — R2-N2/N3); lazy
  window-eviction triggers no state-file write (R3-L2); a manifest-key
  removal mid-episode closes `manifest-changed`, never `restored` (R2-L5); a
  post-restart advert with a RESET `beatSeq` is accepted as fresh (R2-L1);
  escalation fires exactly once; durable state survives reload; corrupt
  state file re-baselines AND adopts-or-resolves the open item first, no
  duplicate HIGH, and carries no pendingFix afterward (N3, R3-L3);
  disable-mid-episode retains state + item AND keeps advertising the alarm
  marker (R3-N3); re-enable on a coherent pool resolves
  `resolved-after-reenable` (§4.6).
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
  PLUS the pull→registry ROUNDTRIP test (R2-N1), scoped honestly (R3-N11) to
  the REGISTRY-BOUND field subset — `quotaState`, `guardPosture`,
  `seamlessnessFlags`, `servesChannels`, `coherenceAdvert` — asserting each
  survives `pullOnce`'s `recordHeartbeat` spread into `MachinePoolRegistry`
  storage (the second hand-maintained enumeration the ratchet alone does not
  cover); the drive*Sync-routed advert fields (journal / commitments /
  preferences) take different paths covered by their own tests;
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
   operator approval (§4.2.1) — and in the F4 topology the divergent Mini is
   NOT the raiser, so v1 fully mechanizes the alarm/proposal/approval while
   the final write is the agent's own hand on the Mini inside the bounded
   held-fix window (§4.2.1-iv); unattended auto-equalization and a
   structural cross-machine execution channel are Phase 2's authority
   question.
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
- **D9 (M1, extended R2-L5/R3-M3) — Close-reason taxonomy + suspension
  trigger.** `restored` / `suspended-peer-offline` /
  `suspended-peer-unverifiable` / `expired-peer-gone` /
  `superseded-by-takeover` / `resolved-after-reenable` / `manifest-changed`;
  only `restored` claims restoration; suspension covers BOTH the offline and
  the can't-verify (advert-stale/unknown/rejected participant) cases, pauses
  the escalation clock; changed-set passes count toward nothing (§4.3).
- **D10 (M2) — Recurrence brakes.** Re-open window 60 min; ≤ 3 new episode
  items/day, then jsonl-only + one loud give-up (§4.5).
- **D11 (M4) — Clamp-rejection semantics.** Rejected ≠ absent: rejection
  marker replaces the stored advert, peer surfaces as `advert-rejected`
  (§3.2).
- **D12 (M5, extended R2-L1) — Advert staleness.** Receipt stamp
  (`advertReceivedAtMs`) is the ONLY freshness authority; `advertStaleMs:
  5 min` → `advert-stale`; `beatSeq` is forensic-only (restart resets it —
  never a monotonicity gate) (§3.2).
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
- **D19 (R2-M1, refined R3-M2/M4/N4/L1, completed R4-M1) — Raise-liveness
  fallback.** The advert gains an `alarm` marker (N4-format episodeId +
  per-row identity hashes of the CURRENTLY-confirmed rows,
  intersection-tested, clamped ≤ 72 — ≥ any ratchet-passing manifest — with
  a truncation flag that NEVER grants coverage: an unlisted row is NOT
  covered, failing toward raising). The marker keys on item-RAISED
  (`itemRaisedAt`, written on `createAttentionItem` SUCCESS), never on
  episode-open — a dead-adapter raiser advertises no phantom coverage
  (R4-M1).
  Raise-silent is defined precisely: only the ELECTED raiser (live-guard,
  no covering marker past its deadline) is ever classified raise-silent;
  subtraction is iterative with per-raiser deadlines; a standby steps up IFF
  it is the election result over the remainder — exactly one, from shared
  inputs. The takeover/fallback latch re-arms on owner-return
  reconciliation; silence clocks + latch records drop on
  row-clear/episode-close. Byzantine marker forgery by an own machine is an
  accepted residual (mesh trust model) (§3.2/§3.4).
- **D20 (R2-M2, refined R3-M3/L5/N10) — Duplicate-item reconciliation.** ONE
  rule, keyed on the N1 row-identity set (never episodeId): a holder
  observing a peer's intersecting `alarm` marker applies the survivor pick —
  LOWEST machineId among holders, computed from marker data alone
  (lease-view-independent); non-survivors resolve `superseded-by-takeover`
  cross-referencing the survivor + invalidating their pendingFix. The blind
  side of a one-directional degradation SUSPENDS (can't-verify) instead of
  dueling. The forged-marker active-supersede is a named accepted residual.
  §0(b) restated honestly: one item under a coherent view; bounded,
  honestly-marked, converging (or suspended-quiet) duplicates under degraded
  views (§0/§3.4).
- **D21 (R2-M3, completed R3-M1/M6/N5/N6/N7/N8/N12, state-scoped R4-M2 +
  R4-N1/N2/N4/N6/L8) — The approved fix, fully pinned.** Approval = verified
  operator uid + exact recorded proposal (ScopeAccretionRatifier shape,
  message-id-chained; the conversational agent recognizes the reply, the
  hash+chain is the authority; the reply match invokes the server's internal
  fix-execution action in-process); ONE pendingFix per episode with THREE
  states (proposed / approved-holding / executing-verifying): the two
  UNEXECUTED states are invalidated by skew-set change / any close /
  suspension (NAMED note when it hits an approved-holding fix) /
  supersession / re-baseline, with a refused-with-note stale approval; an
  EXECUTING fix is never invalidated by suspension — its verify clocks
  pause and resume (R4-M2). Re-proposals render in-place, operator-gated,
  never an autonomous stream (R4-N1); "leave it" is a durable episode-state
  ack, cleared on recurrence re-open (R4-N2). Execution is idempotent;
  single-flight = the surviving holder's pendingFix substate + the divergent
  machine's atomic funnel with a no-diff-no-restart gate (never two
  conflicting writes; a redundant no-op write in the blind-side window is
  bounded and stated — R4-N4). Direction = pool-majority else lease-holder
  value, always named; the write is the explicit override yielding the
  target effective value, via the atomic config funnel;
  `developmentAgent` + the guard's own posture row are never auto-proposed.
  V1 MECHANIZES execution only for divergent == raiser (write-ahead
  outcome, then process-exit under the keepalive supervisor — never the
  self-bootout `restartServer()`; unsupervised hosts degrade to the held
  path — R4-N6/L8; a lease-holder restart is named a failover); any other
  divergent machine → a bounded, honest HOLD (2 × fixVerifyTicks from
  approval, suspension-aware) — no mesh config-write exists or is added,
  and the §4.2 body promises exactly this. Failure is one loud append +
  episode stays open — the fix path can never close an episode; "leave it"
  suppresses the §4.4 escalation (§4.2/§4.2.1).
- **D22 (R2-N4, extended R3-M5 + R4-N3/N5/L6/L7) — Flap bounding.**
  `flappingLatchReopens: 3` → latched flapping for episode re-opens; PLUS a
  per-episode rolling append budget (`episodeAppendBudget: 6` /
  `episodeAppendWindowMs: 6 h`) SHARED across all intra-episode transition
  classes (row re-joins, suspend/resume, takeover re-arms — never a budget
  per class), with one slot reserved for the first suspend/resume per
  window, a pinned latch exit (rolling count falls back below budget), and
  latched-mode flap transitions dropping to jsonl-only INCLUDING the
  durable state-file write; burst-invariant test runs the classes
  individually AND concurrently; the per-day-cap give-up append targets the
  most-recent item's TOPIC (works on a resolved item; degrades to
  jsonl-only) (§4.5).
- **D23 (R2-N2/N3, extended R3-L2 + R4-N2) — Brake persistence split.**
  Recurrence/cap/latch/append-budget bookkeeping + the "leave it"
  operator-ack flag are DURABLE (live in the episode state file,
  transition-only writes, outlive episode close); confirm/resolve/verify
  tick counters are in-memory (restart cost ≤ one window, absorbed by
  warm-up); rolling-window eviction is lazy and never itself writes
  (§4.1/§4.5).

## Decision points touched

- The guard introduces **no block/allow/route gates** — it is signal-only end
  to end (evaluator → attention item). The only actuation anywhere in its
  design is the §4.2.1 agent-performed fix, which executes solely on the
  VERIFIED operator's explicit approval of one exact recorded proposal
  (Agent Proposes, Operator Approves; Know Your Principal), is always a
  LOCAL write on the divergent machine, and can never close an episode.
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
| `pullOnce`'s hand-maintained `recordHeartbeat` field spread + deps type (the second enumeration the ratchet misses — R2-N1) | `src/core/PeerPresencePuller.ts:254` (spread), `:172` (deps type) |
| Atomic config-write funnel the fix uses (R3-N12) | `src/core/BootSelfKnowledge.ts:112` (`writeConfigAtomic` — re-read → mutate → tmp+rename); already the funnel at `src/server/routes.ts:18883-18930`; the raw `PATCH /config` body (`:21323`, R4-L5-corrected) is NOT atomic — the fix does not use it |
| The one-level-deep config-merge clobber hazard, correctly cited (R3-L4) | `docs/specs/GUARD-POSTURE-ENDPOINT-SPEC.md` §2.5 (the 2026-06-11 sessionReaper remediation incident; "wholesale-replaces nested objects") |
| Only 4 of 7 `SESSION_STATUS_ADVERT_FIELDS` are registry-bound via `recordHeartbeat` (R3-N11's test scope) | `src/core/PeerPresencePuller.ts:254` (spread: quotaState/guardPosture/seamlessnessFlags/servesChannels); journal/commitments/preferences adverts flow via `driveJournalDelta`/`driveCommitmentsSync`/`drivePreferencesSync` (`:258-267`) |
| The naive in-process restart is self-defeating; the supervisor-exit + lifeline-signal primitives are the real carriers (R4-N6) | `src/commands/server.ts:21630` (`restartServer` — launchd path boots out the calling process), `src/core/version-skew.ts:82` (`writeLifelineRestartSignal`) |
| Verified-operator reply-in-topic binding precedent (fix approval — R2-M3-i) | `src/users/TopicOperatorStore.ts:57`; `src/core/ScopeAccretionRatifier.ts:185-186` (uid match), header doc (display integrity via message-id chain) |
| Pool-scope attention merge (the operator's cross-machine view of the one item) | `src/server/routes.ts:12521-12644` (`attentionPoolMerge`) |
| Per-peer clock-skew detection + placement ineligibility (R2-N5's mitigation) | `src/core/MachinePoolRegistry.ts:63` (`clockSkewTransition`), `:222-271` (tolerance + 2-beat removal), `:281` (`clockSkewStatus`) |
| House bounded-jsonl retention shape (R2-L2) | `src/monitoring/SessionWatchdog.ts:1128` (`rotateLog`, 30-day age prune) |
