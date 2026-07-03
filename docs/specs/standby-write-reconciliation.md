---
title: "Standby-Write Reconciliation + Typed Refusal — ownership-scoped write admission for the active-active pool (P2-6 / F9)"
slug: "standby-write-reconciliation"
author: "echo"
status: "draft (round-3 revision — all round-2 findings folded; see §12 disposition)"
eli16-overview: "standby-write-reconciliation.eli16.md"
parent-principle: "A Refusal Stays a Refusal — a write the server cannot complete returns an immediate typed refusal or a bounded error, never an open-ended hang"
sibling-principles: "Structure > Willpower; Verify the State, Not Its Symbol; Signal vs Authority; Maturation Path — Every Feature Ships Enabled on Developer Agents; Bounded Blast Radius; User Experience Is the Product (a hung write is an unreachable agent); The Agent Is Always Reachable (an unowned local session's writes must never gate on pool custody)"
parent-spec: "docs/roadmaps/instar-two-goal-roadmap-2026-07.md §4.3; docs/audits/mm-current-state-2026-07.md (F9, P2-6); docs/audits/multi-machine-seamless-ux-audit-2026-07.md §6 — NOTE: these three live in the operating agent's home workspace (session-A docs), NOT in this repo; a repo reader should not chase these paths here"
project: "session-a-phase-4.3 (topic 29836)"
depends-on: "StateManager read-only guard (src/core/StateManager.ts:102-139) + sessionScoped carve-out (standby-pool-session-writes.md); MultiMachineCoordinator role/lease reconciliation (src/core/MultiMachineCoordinator.ts:1181-1200); session-pool CAS custody (MULTI-MACHINE-SESSION-POOL-SPEC.md); SessionOwnership FSM + SessionOwnershipRegistry/LocalSessionOwnershipStore (src/core/SessionOwnership.ts, src/core/SessionOwnershipRegistry.ts, src/core/LocalSessionOwnershipStore.ts); U4.3 typed-refusal contract (u4-3-breaker-recovery-probe.md — a TYPED refusal is distinguishable from success AND from garbage); WS2.5 evolution-actions replication (ws25-evolution-actions-replication.md); WS4.1 durable remote-ack (prior art for owner-routed attention mutation)"
upstream-feedback: "fb-99ab6347 (POST /evolution/actions hangs; hypothesis revised by this spec's grounding — see §1.4)"
review-convergence: null   # round 3 in flight — has not converged
approved: false
---

# Standby-Write Reconciliation + Typed Refusal

## 0. One-paragraph summary

The mesh has two contradictory models running at once: the **one-awake** model
(the serving lease flips the WHOLE StateManager read-only on every non-holder —
one process-wide boolean) and the **active-active session pool** (per-topic CAS
custody deliberately places owned, serving sessions on "standby" machines). The
collision is F9's sharpest line: *the Laptop's StateManager was READ-ONLY
("standby") while actively OWNING pool topics*. Meanwhile the P2-6 family showed
mutating routes (`POST /evolution/actions`, `POST /attention`) hanging
open-endedly instead of refusing. This spec (roadmap 4.3) replaces the blanket
boolean with **ownership-scoped write admission** — every write is classified
into a write **domain** (machine-local / session-scoped / topic-scoped /
cluster-shared) and admitted by a synchronous in-memory check grounded on the
session-pool FSM's single-owner guarantee — and gives every inadmissible write
a **typed, machine-readable refusal in <2s**, never a hang.
It also closes the P2-6 root-cause file honestly: the hangs are NOT a blocking
lock in the write path (§1.4) — the admission layer makes refusal instant and
measurable, and the event-loop-starvation arm is instrumented here and tracked
as its own work item (P1-A7/P2-A8).

## 1. Problem — root-caused (grounded 2026-07-02, v1.3.722 tree + live probes)

### 1.1 The contradiction (F9): write authority is lease-shaped, ownership is topic-shaped

Write authority today is ONE process-wide boolean derived ONLY from the serving
lease:

- `MultiMachineCoordinator.reconcileRoleToLease` —
  `src/core/MultiMachineCoordinator.ts:1190`: `this.state.setReadOnly(!holds)`.
  Also set on startup (`:446`), demote (`:578`), promote (`:544`).
- `StateManager.guardWrite` — `src/core/StateManager.ts:135-139`: when
  `_readOnly`, EVERY guarded write throws
  `"StateManager is read-only (this machine is on standby). Blocked: <op>"`,
  with exactly one carve-out: `sessionScoped` writes when `_sessionPoolActive`
  (`src/core/StateManager.ts:123-139`, from standby-pool-session-writes.md) and
  the journal-prefix allowlist (`guardJournalWrite`, `:162-171`).

But pool custody is per-topic CAS: a non-lease-holder legitimately OWNS and
SERVES topics. Live evidence captured this session (Laptop stderr, 2026-07-02):

```
[SessionManager] Failed to record build context for "echo-interactive-…":
  StateManager is read-only (this machine is on standby). Blocked: set
```

`SessionBuildContextStore.record` (`src/core/SessionBuildContextStore.ts:52`;
the underlying kv write is `writeAll` → `state.set` at `:105`, key
`session-build-context`, `:6`) is a write about a session THIS machine owns
and is serving — blocked by the blanket boolean because it routes through the
kv `set` (a "shared" op by default). Every added machine is a standby-shaped
writer-that-can't-write (mm-current-state §D.5): the model cannot scale past
N=2 because N−1 machines are write-crippled for state they own.

### 1.2 There is no refusal layer — most mutating routes never consult ANY write gate

Neither route in the P2-6 family touches the read-only guard at all:

- `POST /evolution/actions` (`src/server/routes.ts:18012`) →
  `EvolutionManager.addAction` (`src/core/EvolutionManager.ts:1245`) →
  `loadActions`/`saveActions` (`:1167/:1174`) → `readFile`/`writeFile` on the
  `'action-queue'` name (`:1168/:1201`) — **plain synchronous fs to
  `state/evolution/action-queue.json`**, bypassing StateManager entirely.
  (Distinct store, do not conflate: `state/evolution/evolution-queue.json` is
  the PROPOSALS store — `loadEvolution`/`saveEvolution`, `:781/:788`, write at
  `:813` — and is not in this route's path at all. Round-1 finding S1 asserted
  the opposite and was mis-diagnosed; §8's I3/store-snapshot probes must
  assert against `action-queue.json`.)
- `POST /attention` (`src/server/routes.ts:12323`) →
  `TelegramAdapter.createAttentionItem` (`src/messaging/TelegramAdapter.ts:3798`)
  → `saveAttentionItems` (`:4244`) — **plain synchronous fs to the adapter's
  `state/attention-items.json`**, also bypassing StateManager.

So "standby is read-only" is enforced ONLY for StateManager-routed writes.
Everything else silently writes machine-local files on whichever machine the
request lands on. There is no typed refusal because there is nothing that could
refuse: no layer knows which machine a given write belongs to. The observed
"standby write model" is therefore not a strict model at all — it is a blanket
guard over one store, holes for everything else, and no admission decision
anywhere.

### 1.3 Why the routes HANG instead of erroring: the handler paths are bounded; the process is not

Root-cause-first finding: **every await in both P2-6 routes is bounded when the
event loop is live** —

- The outbound tone gate is raced against a hard budget:
  `reviewWithinBudget(...)` at `src/server/routes.ts:2038` with
  `OUTBOUND_GATE_REVIEW_BUDGET_MS = 20_000` (`src/server/middleware.ts:391`);
  every disposition (open/hold/degrade) produces a verdict.
- Every Telegram API call aborts at 15s (60s for the long-poll `getUpdates`):
  `TelegramAdapter.apiCall` (`src/messaging/TelegramAdapter.ts:5361-5364`,
  `AbortController` + `setTimeout(abort, timeoutMs)`).
- `EvolutionManager` I/O is synchronous (`readFile`/`writeFile`,
  `src/core/EvolutionManager.ts:750/761`) — it cannot park a request.
- A 30s request-timeout backstop exists for every route:
  `requestTimeout` wired at `src/server/AgentServer.ts:936`, timer-based 408 at
  `src/server/middleware.ts:503`.

A zero-byte, ≥90s hang with no 408 (the audit's exact observation) is only
possible when **timer callbacks do not run** — the 408 guard is itself a
`setTimeout`, so it starves together with the route. Live reproduction during
this spec's grounding (Laptop, 2026-07-02 ~14:42-14:46 PDT, pid 78257,
v1.3.722):

- `GET /health`, `GET /attention`, `GET /evolution/actions` ALL hung 8-35s with
  instant TCP connect (`time_connect` 0.0003s, zero response bytes) — the kernel
  accept queue accepts while no JS runs.
- `sample(1)` of the serving process: main thread inside `uv__run_timers` → JS →
  **synchronous `fs.readFileSync` / `readdir`** — sync fs I/O inside timer
  callbacks starving the loop, ~90s after a crash-loop restart
  (`[FATAL] Uncaught exception … Sent before connected.`).
- Same stderr window: `[DEGRADATION] MultiMachine.leaseTick: … stalled (no
  advance in >600000ms)` — a >10-minute dead window in the coordinator tick —
  plus repeated `SleepWakeDetector: Drift ~9-62s under load ratio 8-10 —
  treating as CPU starvation` (the P1-A7 signature).
- The server then died mid-probe (connection refused) — the crash loop
  (`server-crash-loop-sleepwake` memory item) means boot-storm windows recur.

This also explains the audit's differential without a second mechanism: under
an **intermittently** starved loop, a cheap synchronous GET completes within one
service window, while a POST that needs body parse + an LLM-gate round + two
Telegram API round-trips needs many service windows and blows any curl budget —
"GET answers, POST hangs". And a fresh-boot probe (the v1.3.720 addendum, where
GET **and** POST `/evolution/*` hung on BOTH machines) lands in the boot storm,
where everything hangs — as reproduced above with `/health` itself hanging.

### 1.4 Consequence for fb-99ab6347 (hypothesis revision)

fb-99ab6347-a44's working hypothesis was "handler blocks at store load/mount,
possibly the WS2.5 replicated-store init". This spec's grounding **refutes the
handler-level arm**: `listActions`/`addAction` are synchronous over plain fs
(§1.3) and cannot park a request; there is no store mount in the request path.
The evidence (zero bytes + no 408 + `/health` hanging in the same windows +
the `sample` stack) points at **process-level event-loop starvation windows**
(boot storms of sync fs in timers; the sleep/wake crash loop restarting into
those storms; P1-A7 stalls). The build phase of THIS spec must
confirm-or-falsify with the §6 event-loop instrumentation before fb-99ab6347 is
closed; the starvation root itself (making boot/timer work async, the crash-loop
fix) is P1-A7/P2-A8 scope, deliberately NOT this spec's (§2 Non-goals).

## 2. Goal / Non-goals

**Goal.** (a) *Ownership-scoped writes:* a machine that owns pool topics gets
writes for the state it owns — the blanket lease-boolean is replaced by a
write-domain model in which machine-local and owned-session/topic state is
writable everywhere it legitimately lives, and only genuinely cluster-shared
state stays lease-holder-only. (b) *Typed refusal:* a mutating route that is
genuinely inadmissible on this machine refuses in <2s with a machine-readable
reason — never a hang, never a bare 500, and a refusal mutates nothing.
(c) The U4 audit findings become registrable: `POST /evolution/actions` and
`POST /attention` succeed (or typed-refuse) in <2s on BOTH machines (§8
live-proof), unblocking attention item `agent:mm-audit-registration-debt-2026-07`.

**Non-goals.**
- NOT fixing the event-loop starvation root (sync-fs boot storms, the
  sleep/wake crash loop, P1-A7 stall-vs-sleep discrimination, P2-A8 exit
  logging). This spec *instruments* loop health (§6) so hang windows are
  measurable and attributable, and bounds what a live loop can do; it does not
  refactor boot.
- NOT write-forwarding/proxying to the owner (a refusal names the owner; the
  caller re-targets). Forward-on-refusal is the named Phase-2 follow-up
  `write-forward-on-refusal` (frontloaded decision §9.13) — deliberately out of
  wave 1 and wave 2.
- NOT relaxing any cluster-shared write on a non-holder. Fork-safety for
  lease/jobs/kv/events is never weaker than today (invariant I4).
- NOT changing WS2.x replication semantics — the domain model rides the
  existing per-machine-store + replication-emitter architecture unchanged.
- NOT a general request-timeout redesign.

## 3. Design

### 3.1 D1 — Write-domain taxonomy (the model that replaces the boolean)

Every mutating surface is classified into exactly one domain:

| Domain | Definition | Admission rule | Examples (initial classification) |
|---|---|---|---|
| `machine-local` | This machine's own single-writer store; cross-machine convergence is handled by the entry's **named convergence story** (see below — for a git-synced shared path the story must carry BOTH axes) | **Admit on every machine, always** — lease-irrelevant, pool-state-irrelevant | evolution stores (`state/evolution/*` — logical story: WS2.5 replication for `action-queue.json` ONLY, and only where `multiMachine.stateSync.evolutionActions` is enabled (the emitter is injected in `saveActions`, `EvolutionManager.ts:1212`; dark on the fleet, so the fleet's logical story today is honestly "none yet"); file-level arm: `git-sync-excluded` — a wave-1 build item, see below), attention items (`state/attention-items.json` — resolves to `<stateDir>/state/attention-items.json` on the primary bot (`botStateDir === stateDir`, `TelegramAdapter.ts:809/:816`); logical story: pool-scope GET merge + WS4.1 ack; file-level arm: `git-sync-excluded` — same wave-1 build item), learnings (WS2.2), knowledge (WS2.4), coherence-journal own streams (the existing `guardJournalWrite` allowlist folds in unchanged, **including its path jail** — the prefix check at `StateManager.ts:162-171` that throws on any path escaping the journal root even when NOT read-only survives the refactor verbatim), **`SessionBuildContextStore` under its per-machine re-key (§3.3 — convergence: per-machine key, single-writer per file)**. (`corrections` was listed in earlier drafts with NO story — a direct I9 violation; it is DROPPED from the initial classification and re-enters only via the wave-2 inventory with a real story.) |
| `session-scoped` | State keyed to ONE session, whose owning machine is determined by pool custody (via the session's topic binding — see keying note below) | The §3.2 decision table, `session-scoped` row: unbound / binding-miss / no-record / released ⇒ admit (today-equivalent); owned record ⇒ admit iff FSM owner = this machine | `saveSession`/`removeSession` (`StateManager.ts:203/:369` — today's `sessionScoped` carve-out generalizes into this rule) |
| `topic-scoped` | State keyed to ONE topic; owner = the pool custody record for `String(topicId)` | The §3.2 decision table, `topic-scoped` row: no-record / released ⇒ **legacy lease boolean** (byte-identical to today — I4 by construction) unless the registry entry declares an explicit absent-window convergence story; owned record ⇒ admit iff FSM owner = this machine | topic profiles, topic intent, per-topic resume UUIDs (full inventory is the wave-2 grounding artifact — §3.5, ladder gate §7) |
| `cluster-shared` | Genuinely shared cluster state; single-writer = lease holder | Admit iff this machine holds the serving lease — **byte-identical to today** | lease records, job schedule state (`saveJobState`), kv `set`/`delete` (default for unclassified keys), `appendEvent` |

**Keying honesty (one index, two key derivations).** Pool custody is keyed by
TOPIC id: the pool's `sessionKey` IS the stringified topic id
(`src/commands/server.ts:20203` — `sessionKey = String(topicId)`). So the two
scoped domains resolve against the SAME ownership index with different key
derivations: `topic-scoped` uses `String(topicId)` directly; `session-scoped`
first maps session → topic via the **in-memory topic-session binding**
(`TelegramAdapter.getTopicForSession`, `src/messaging/TelegramAdapter.ts:2294`,
backed by the persisted `topic-session-registry.json`, `:813` — the in-memory
map ONLY; the disk-fallback `resolveTopicForSessionFromDisk` (`:2317`) is
forbidden on the admission path, I2). Scope resolution is the CALLER's job
using data already in hand (e.g. `saveSession` holds the Session record with
its `tmuxSession`); `admitWrite` receives a resolved scope and never looks
anything up outside its in-memory index.

**Convergence-story requirement (structural, not advisory — TWO axes).** Every
`machine-local` registry entry MUST carry a named convergence story, one of:
`ws2x-replicated` | `pool-scope-read-merge` | `per-machine-path` (the file
path or kv key embeds the machine id — single writer per file by construction)
| `git-sync-excluded` (listed in `FileClassifier` sync exclusions,
`src/core/FileClassifier.ts:122-151`) | `ephemeral-rebuildable`. **Second
axis (the round-2 S1 lesson):** a LOGICAL story (`ws2x-replicated`,
`pool-scope-read-merge`) says nothing about the FILE — two machines rewriting
the same git-synced file still manufacture recurring merge conflicts no matter
how the logical state converges. So any machine-local entry whose store sits
on a git-synced shared path MUST ALSO name its file-level arm:
`per-machine-path` or `git-sync-excluded`. A shared-path store missing either
axis is **refused classification** and stays `cluster-shared` (I8/I9) — this
is the generalized M3-b lesson. (Honesty: the registry schema does not make
the fork *unrepresentable* — it makes a story-less classification refusable
and the two-axis requirement lint-checkable; the enforcement is the I9 schema
validation + Tier-1 test, §8.) **Concrete wave-1 build item:** add
`.instar/state/attention-items.json` and `.instar/state/evolution/` (plus any
other path classified machine-local on a shared git-synced location by the
wave-2 inventory) to `FileClassifier`'s sync exclusions — today
`.instar/state/` is NOT excluded (`FileClassifier.ts:122-151`), so both
wave-1 route families' stores ride git-sync. This exposure is PRE-EXISTING
(both routes already bypass StateManager and write locally on every machine
today, §1.2) — the build item closes it rather than merely not-regressing it.

Default posture is fail-closed toward today's behavior: a StateManager op or kv
key with NO classification is `cluster-shared` (exactly the current guard). A
ROUTE with no declaration gets no admission wiring (no behavior change) but is
flagged by the conformance lint (§3.5) so coverage ratchets instead of rotting.

### 3.2 D2 — `WriteAdmission`: one synchronous, in-memory decision point

A new `WriteAdmission` primitive (src/core/WriteAdmission.ts):

```ts
admitWrite(domain: WriteDomain, scope?: { topicId?: number; sessionId?: string })
  : { admit: true } | { admit: false; refusal: TypedWriteRefusal }
```

Hard properties (invariant I2):
- **Synchronous and in-memory only.** No fs, no network, no LLM, no await on
  the admission path. It reads (a) the lease view the coordinator already
  maintains in memory, (b) the **ownership index** (below), (c) the domain
  registry (§3.5). Answer time is microseconds — the <2s SLO is met by
  construction whenever the loop is alive.

**The ownership index (decided — was OQ1).** `admitWrite` does NOT call
`SessionOwnershipRegistry.read()`: the production substrate
(`LocalSessionOwnershipStore`) does a synchronous `existsSync`+`readFileSync`
on every cache miss (`loadOne`, `src/core/LocalSessionOwnershipStore.ts:61-79`)
and **does not cache negative results** — a keyless write would `existsSync`
on every admission, violating I2. Instead WriteAdmission owns an
`OwnershipIndex`, kept correct by construction:

1. **Boot warm:** ONE synchronous `store.all()` scan at construction
   (`LocalSessionOwnershipStore.all`, `:119-139` — the one-time directory scan
   behind the `scanned` flag, over `<stateDir>/ownership/local`,
   `src/commands/server.ts:17434-17437`), deliberately off the request path.
   After the warm the index holds the COMPLETE local record set, so a negative
   answer ("no record for this scope") comes from memory — no per-miss fs.
2. **Transition hook at the `SessionOwnershipStore` INTERFACE (round-2 S4):**
   `onCommit(record)` is ADDED to the **store contract** (the
   `SessionOwnershipStore` interface, `SessionOwnershipRegistry.ts:65-81`),
   NOT as a private detail of one substrate — each shipped substrate fires it
   at its own mutation point:
   `LocalSessionOwnershipStore` inside `persist()` (after `cache.set`,
   `LocalSessionOwnershipStore.ts:81-95`), and
   `InMemorySessionOwnershipStore` inside `casWrite()` at its `recs.set`
   (`SessionOwnershipRegistry.ts:53-57` — that substrate has NO `persist()`
   funnel, so a Local-only hook would leave the index
   warm-once-then-permanently-stale whenever the pool runs on InMemory).
   Today that combination is near-benign only emergently —
   `shouldActivateDurableOwnership` forces the durable store on any machine
   consuming replicated placements (`src/commands/server.ts:17426-17441`) —
   but that is another feature's activation logic, not a guarantee this spec
   may lean on. BOTH mutation paths funnel through the store's own commit
   point — `registry.cas()` → `store.casWrite`
   (`SessionOwnershipRegistry.ts:172`), AND `OwnershipApplier` materializing
   replicated journal placements via the SAME `store.casWrite`
   (`src/core/OwnershipApplier.ts:211`). There is no third writer; the index
   can never miss a transition the local store saw.
3. **Parity by construction:** the index mirrors the store's in-memory cache
   exactly (asserted by a Tier-1 parity test over arbitrary cas/applier
   sequences, run against **BOTH shipped substrates** — §8). Cross-machine
   staleness — the local store lagging true mesh custody until the next
   `OwnershipApplier` tick — is the accepted §5 TOCTOU residual, identical to
   the window message-routing already lives with.
4. **Ingest validation (round-2 L1):** the index validates every record AT
   INGEST — `ownerMachineId` must be a string and `status` one of the known
   FSM statuses — regardless of which store path surfaced it. This is
   necessary because the store's own validation is asymmetric: `loadOne`
   requires `ownerMachineId` to be a string
   (`LocalSessionOwnershipStore.ts:67`) but the warm-scan `all()` validates
   only `ownershipEpoch` + `sessionKey` (`:127`) and caches the weaker
   record. A record failing ingest validation is classified **malformed ⇒
   fail-closed** — the §3.2 decision table's malformed/unwarmed arm
   (`ownership-unresolved`), never a `not-owner` refusal with `owner: null`.
5. Until the boot warm completes, scoped-domain verdicts are
   `ownership-unresolved` (fail closed, `retryable:true`); the warm is
   synchronous at construction so the window is one boot instant. In
   practice this clause is DEFENSIVE-ONLY and unreachable for any caller:
   the warm runs synchronously INSIDE the constructor on a single-threaded
   runtime, and the one-way attach (§3.2 pre-construction window) happens
   after construction — so no `admitWrite` call can ever interleave with
   the scan, and this clause can never produce a refusal today (no
   availability regression relative to the carve-out). It exists for a
   future substrate whose warm might be deferred.
   The `InMemorySessionOwnershipStore` (dev-gate-off substrate) is trivially
   covered for warm cost (its `all()` is already pure memory) and covered for
   transitions by the interface-level hook above.

**The scoped-domain admission decision table (decided — was M2 + M5; split by
domain in round 3 — was C1).** For `session-scoped` / `topic-scoped` writes,
**when the session pool is active** (`_sessionPoolActive`, set at
`src/commands/server.ts:19525`), resolve scope → topic key (§3.1 keying note),
look up the ownership index, and admit per ONE coherent table — the two
domains share the owner check but deliberately DIVERGE on the absent/released
arm, because their today-baselines diverge (that divergence is what keeps I4
true in both columns):

| Index state for the scope | `session-scoped` | `topic-scoped` |
|---|---|---|
| UNBOUND — session has no topic binding (locally-spawned job / headless / lifeline sessions — never pooled), or the in-memory binding map misses | **ADMIT** (machine-local-by-construction) | n/a — a topic-scoped write carries its topic id; there is no binding step to miss |
| No record, or record `status:'released'` | **ADMIT** — today-equivalent: the current `sessionScoped && _sessionPoolActive` carve-out (`StateManager.ts:135-139`) already admits EVERY session write on a pool-active standby, so admit-on-absent/released only ever *tightens* relative to today | **LEGACY LEASE BOOLEAN** — admit iff NOT `_readOnly`, else refuse `read-only-standby`. Byte-identical to today (every topic-keyed kv write routes through `guardWrite` and is refused on every non-lease-holder), so I4 holds **by construction**. EXCEPTION: a registry entry may opt into admit-on-absent ONLY by declaring an explicit absent-window convergence story (I9-audited, both axes) — the default is the legacy boolean |
| Record in `placing` / `active` / `transferring` | **ADMIT iff `record.ownerMachineId === thisMachineId`**, else refuse `not-owner` naming the owner — identical rule, both domains | same |
| Index not yet warm, or record malformed (failed §3.2 ingest validation) | `ownership-unresolved` (fail closed, `retryable:true`) — reserved for genuine ambiguity ONLY | same |

Why the absent/released arms differ (the I4 reconciliation, stated once):
`session-scoped`'s admit-on-absent arm is the round-1 M2 reachability case —
its today-baseline ADMITS (the carve-out), so admitting cannot create a fork
that today's behavior doesn't already permit. `topic-scoped`'s today-baseline
REFUSES on every non-holder (the blanket boolean) — an admit-on-absent arm
there would put two writers on one shared per-topic path during pool
cold-start or background sweeps over stale bindings on two machines: exactly
the dual-writer fork I4(a)/(b) and §2 Non-goals promise cannot happen. The
round-2 draft applied one uniform arm to both domains and contradicted I4;
this table is the resolution, not a patch-over.

Unbound-arm rationale (unchanged from round 2): per-session files are keyed
by per-spawn session ids (no cross-machine fork surface), and refusing on a
binding miss would gate serving an inbound message on a standby — the exact
"Agent Is Always Reachable" regression this rule exists to prevent.

Released-arm grounding correction (round-2 S3): the round-2 draft justified
released⇒admit via "eviction-consistency: `releasedEvictionMs` deletes
released records after 24h" — **that mechanism does not run.**
`releasedEvictionMs` appears exactly once in src/ — the deps declaration
(`SessionOwnershipRegistry.ts:91`); no sweep consumes it,
`LocalSessionOwnershipStore` has no delete/unlink path at all, and released
records currently persist indefinitely. It is a **known dead knob — do not
re-cite it as an active mechanism.** Neither arm needs it: `session-scoped`
released⇒admit stands on today-equivalence alone (the carve-out admits it
today), and `topic-scoped` released⇒legacy-boolean needs no eviction argument
at all (released and absent produce the same verdict by the table, so a
future eviction implementation changes nothing).

Owner-check grounding (unchanged): the FSM names exactly ONE machine in every
non-released state — `ownerOf` returns `ownerMachineId` for all three
(`SessionOwnershipRegistry.ts:133-138`); `placing` names the placed owner,
`transferring` names the draining source until the target's claim lands
(`placementTargetOf`, `:144-150`, distinguishes the target; the
output-exclusion contract in `SessionOwnership.ts` already governs who acts
during a transfer). Consequence for the known F1 `placing`-wedge topics: the
placed owner KEEPS its writes (ownerOf names it) — this spec has **no
dependency on the F1 fix** and never turns a wedged placement into a
permanent owner-write refusal. There is no `contested` state in the FSM
(custody is a committed CAS record); the round-1 draft's
"placing/contested → refuse" is retired.

**When the session pool is INACTIVE** (pool dark, or
`multiMachine.writeAdmission` live on a pool-dark install — was S5): scoped
domains **collapse to the legacy lease boolean** — admit iff NOT `_readOnly`,
refuse `read-only-standby` otherwise. That is byte-identical to today's
behavior (scoped writes blocked on a pure one-awake standby, admitted on the
holder); the machine-local-by-construction argument deliberately does NOT
apply when the pool that would justify it is off. `machine-local` admits
everywhere regardless of pool state (that is its definition — and matches the
route reality of §1.2, where those stores already write locally on standbys).

- **Fail-closed on ambiguity** (I5, narrowed as above): a genuinely-empty
  ownership index on a single-machine agent admits (no peers ⇒ nothing to
  fork — I6).
- Consumed at BOTH seams:
  1. **Route seam:** mutating routes call it FIRST (§3.4).
  2. **Store seam:** `StateManager.guardWrite` delegates to it (§3.3) so
     non-HTTP writers (SessionManager, schedulers) get the same verdicts.
- **Pre-construction window (round-2 L2, explicit):** StateManager exists and
  takes writes long before the pool block that constructs WriteAdmission runs
  (`src/commands/server.ts:17415+`). During that window `guardWrite` runs the
  **legacy blanket verdict** — exactly today's behavior, I8's fail-toward-
  today direction. Attachment (`StateManager.attachWriteAdmission(...)` or
  equivalent) is **one-way** (never detached at runtime) and happens **before
  routes are wired**, so no HTTP mutating route can ever observe a
  half-attached state; only boot-time internal writers ride the legacy
  verdict, which is what they get today anyway.

### 3.3 D3 — StateManager re-scope: the boolean becomes one domain's input

`guardWrite(operation, opts)` gains a resolved domain (from the registry, by op
name + optional key) and delegates:

- `machine-local` → pass (even when `_readOnly`).
- `session-scoped` / `topic-scoped` → the §3.2 decision table (the existing
  `sessionScoped && _sessionPoolActive` carve-out generalizes into the
  session-scoped column; the topic-scoped column's absent/released arm stays
  the legacy boolean; see I4-b for the exact tightening/loosening honesty,
  per domain).
- `cluster-shared` → pass iff NOT `_readOnly` (byte-identical to today).

`setReadOnly` keeps its name and callers (`MultiMachineCoordinator` unchanged at
`:446/:544/:578/:1190`) but its semantics narrow to "the cluster-shared domain
gate" (plus the scoped-domain fallback when the pool is inactive, §3.2).

**kv classification is EXACT-KEY (decided — was OQ4/M3).** No prefix matching
in wave 1: a registry kv entry names one exact key (post-`validateKey` charset,
`StateManager.ts:174-178`). A key whose contents mix domains is **refused
classification** until the store is split or re-keyed — the first instance is
the store below.

**First kv entry: `SessionBuildContextStore` re-keyed per machine (decided —
was M3/M3-b).** The store today is ONE shared kv entry `session-build-context`
(`src/core/SessionBuildContextStore.ts:6`) → ONE file
`state/session-build-context.json` (`state.set` writes
`state/<key>.json`, `StateManager.ts:498-506`) holding a map keyed by tmux
session name. That path is git-synced: `.instar/state/` is NOT in
`FileClassifier`'s sync exclusions (`src/core/FileClassifier.ts:122-151`) and
`GitSyncManager` auto-commit+push is constructed for both roles on git-backed
mesh machines (`src/commands/server.ts:4548`). Admitting that write on every
pool machine would have two machines rewriting the SAME file continuously —
recurring merge conflicts routed to the LLM conflict resolver. So wave 1
**re-keys the store per machine**: `session-build-context-<machineId>` (the
machine id charset-jailed to `[A-Za-z0-9_-]` before embedding, mirroring the
`sessionFileName` jail in `LocalSessionOwnershipStore.ts:35-39`, so
`validateKey` always passes). **Machine-id source + null fallback (round-2
L3):** the id comes from the **coordinator/mesh identity**
(`MultiMachineCoordinator.identity.machineId` — the same identity the
scheduler is handed, `src/commands/server.ts:6228`), NOT from
`StateManager._machineId` (`setMachineId`, `StateManager.ts:93`, has no
production caller in src/ — a dead seam a builder must not improvise
against). When no mesh identity exists (single-machine installs may have
none), the embedded id is the literal **`local`** — safe: no peers ⇒ no
second writer ⇒ no fork; the builder does not invent
`session-build-context-null`. Each machine reads and writes ONLY its own key —
single writer per file, git-sync carries peers' copies inertly. Domain:
`machine-local`, convergence story `per-machine-path`. Build-context restore is
inherently machine-local (the recorded worktree path is on this disk), so
reads never need peers' keys. The legacy `session-build-context` key is left
inert (entries carry a 6h max age, `:7`, so it self-drains) and removed by a
one-time cleanup on the lease holder during the build — never migrated.

A refused store-seam write throws a `WriteRefusedError` carrying the
`TypedWriteRefusal` — callers that today catch-and-log the string keep working
(the message is preserved), and route handlers map it to the §3.4 wire shape.

### 3.4 D4 — Typed-refusal contract (the U4.3 contract, applied to writes)

A refusal is TYPED: distinguishable from success, from a crash, and from
garbage (u4-3 §G4 canary lesson: an untyped 2xx means nothing). Wire shape:

```json
HTTP 409
Retry-After: 5
{
  "error": "write-refused",
  "code": "not-owner" | "lease-required" | "ownership-unresolved" | "read-only-standby" | "admission-error",
  "domain": "topic-scoped",
  "scope": { "topicId": 30193 },
  "thisMachine": { "machineId": "…", "nickname": "the laptop" },
  "owner": { "machineId": "…", "nickname": "the mini" } | null,
  "leaseHolder": "…" | null,
  "asOf": "2026-07-02T21:40:00Z",
  "retryable": true,
  "hint": "This write belongs to 'the mini' — re-send it there. (Advisory only: moving the topic is a consent-gated operator decision, not a step to auto-follow.)"
}
```

Contract clauses:
- **409 for ALL admission refusals, uniformly — including the transient
  `ownership-unresolved` (decided — was OQ5).** 503 is REJECTED for the
  transient case: 503 is the house feature-dark signature on every route, and
  a transient refusal must never be confusable with "feature dark". Instead,
  every `retryable:true` refusal carries a **`Retry-After` header (seconds)**
  so generic HTTP clients back off correctly. (400 stays validation, 408 the
  existing budget backstop.)
- **Caller-retry brakes (P19):** internal callers that catch
  `WriteRefusedError` MUST NOT busy-retry — they ride their existing
  schedules/backoffs (the refusal is re-evaluated on the next natural pass).
  The §6 aggregate alert is the loop tripwire: a caller looping on 409s
  surfaces as ONE deduped item naming the route.
- `owner`/`leaseHolder` come from LOCAL knowledge only, staleness-tagged via
  `asOf` — the refusal itself never makes a mesh call (I7).
- **The `hint` is advisory prose for a HUMAN reader, never an instruction.**
  It must not name a runnable command: moving a topic is consent-gated
  (`POST /pool/transfer` answers 409 `needsConfirmation` for live autonomous
  runs), and an agent auto-following a refusal hint into a transfer would
  bypass that consent shape.
- **Refuse-before-touch** (I3): admission runs BEFORE any store write, any
  Telegram send, any gate call — a refused `POST /attention` has created no
  topic, persisted no item, spent no LLM tokens. A refusal stays a refusal.
- **Bounded-before-expensive** (I1): on mutating routes the admission check is
  the FIRST await-free statement after body validation. **The check runs first
  in EVERY mode, including dryRun (decided — was OQ6):** the check is
  microseconds and side-effect-free, so ordering it first is behavior-neutral
  while dry (the verdict is log-only and the route proceeds into today's exact
  flow, tone gate included); there is no separate "reorder at live" event. The
  only flow that thins out at `dryRun:false` is the refusal path itself —
  refused sends produce no gate decision-log rows, which is precisely I3's
  intent. No caller depends on gate-before-validation side effects (verified
  in the wave-1 route audit).
- The refusal is logged (§6) and NEVER auto-escalated per-event (no attention
  item per refusal — the 2026-05-22 flood lesson; a persistent refusal pattern
  surfaces as ONE deduped aggregate, §6).

### 3.5 D5 — Domain registry + route-seam wiring + conformance ratchet

- A central `WriteDomainRegistry` (data, not scattered constants): StateManager
  op names, exact kv keys, and HTTP route prefixes → domain + scope extractor
  + (for `machine-local`) the named convergence story (§3.1). Single source of
  truth; tests assert against the SAME map the server wires (the PR-#334
  dead-code lesson).
- **Route wiring, wave 1 (this spec):** the P2-6 family — `POST/PATCH
  /evolution/*` (`machine-local`, WS2.5-replicated), `POST/PATCH /attention*`
  (`machine-local`, pool-scope-merge + WS4.1), plus the store-seam
  classifications in §3.1's table. Both wave-1 route families are
  `machine-local` ⇒ **admit everywhere** — the user-visible fix for P2-6 is
  that these writes are admitted (and now instrumented), while the refusal
  machinery is proven by the store seam + tests, ready for wave 2.
- **Wave-2 inventory (decided — was OQ2):** the complete write-surface
  inventory is a **build Phase-1 artifact of THIS spec**, not a deferred
  question: a grounding pass enumerates every mutating route in routes.ts,
  every StateManager op, and every kv key into the registry — each either
  classified (with convergence story where machine-local) or explicitly
  `TODO-classify` (which keeps today's exact behavior and is lint-counted).
  Wave 2 then activates the topic-scoped entries. **Ladder gate (external
  finding #2):** `dryRun:false` is REFUSED until the inventory is complete and
  reviewed — zero mutating surfaces absent from the registry (TODO-classify
  rows are permitted; absent rows are not). §7 carries the gate.
- **Conformance ratchet:** a lint sweep (the standards-enforcement pattern)
  flags any `router.post|patch|delete` in routes.ts with neither a registry
  entry nor an explicit `@write-domain:none` annotation (read-only actions,
  pure-compute triggers). Baseline recorded at build time; the count may only
  go DOWN (no new undeclared mutating routes).
- **Guard-manifest entry (a named build deliverable — was S4):**
  `writeAdmission` is added to the STATIC `GUARD_MANIFEST`
  (`src/monitoring/guardManifest.ts`): `key: 'writeAdmission'`,
  `kind: 'config'`, `configPath: 'multiMachine.writeAdmission.enabled'`,
  `dryRunConfigPath: 'multiMachine.writeAdmission.dryRun'`, `process:
  'server'`, `loadBearing: false` while the legacy blanket guard remains the
  enforcing layer (re-reviewed — and expected flipped — at fleet graduation,
  when the legacy guard's authority is subsumed). The posture row (`GET
  /guards`, `on-dry-run` while soaking) therefore cannot be forgotten: the
  lint that pairs the manifest with boot-constructed components enforces it.

### 3.6 D6 — What does NOT change

- WS2.x replication emitters, tombstones, fingerprints: untouched (the domain
  model is exactly why machine-local writes are safe — replication already owns
  convergence).
- The lease, its fencing, `pollFollowsLease`, U4.2/U4.4: untouched. This spec
  neither moves the lease nor changes who serves.
- The tone gate on `POST /attention`: unchanged semantics; the admission check
  precedes it in every mode (§3.4), but while dry the gate runs exactly as
  today.
- The `guardJournalWrite` path jail (`StateManager.ts:162-171`): survives the
  fold-in verbatim (§3.1) — a path escaping the journal prefix still throws
  even when not read-only.
- Single-machine agents: strict no-op (every domain admits; no refusal is ever
  emitted; the only observable delta is the §6 surfaces existing).

## 4. Invariants

- **I1 Bounded-before-expensive:** no mutating route performs unbounded or
  expensive work (LLM, network, large I/O) before admission has answered.
- **I2 Admission is sync + in-memory:** `admitWrite` never does fs/network/LLM
  on the admission path; p99 < 1ms under test. (The ownership index's ONE
  boot-warm scan happens at construction, off the request path — §3.2.)
- **I3 Refusal mutates nothing:** a refused write leaves zero durable trace
  besides its log row — no partial topic creation, no store write, no send.
- **I4 Fork-safety never weakens:**
  (a) `cluster-shared` on a non-holder refuses in EVERY mode — including
  dryRun, where the LEGACY blanket guard keeps enforcing while the new layer
  only logs would-verdicts;
  (b) each scoped domain is compared against ITS OWN today-baseline (the
  round-3 C1 reconciliation): **session-scoped** — today's pool-active
  blanket admits every session write on a standby; the new rule keeps
  admitting unbound / no-record / released scopes
  (machine-local-by-construction — the M2 reachability guarantee) and refuses
  ONLY a scope whose custody record positively names ANOTHER machine (the
  double-run/fork case) — a strict tightening. **topic-scoped** — today's
  baseline refuses every topic-keyed kv write on every non-holder (the
  blanket boolean); the new rule's absent/released arm IS that legacy
  boolean (byte-identical by the §3.2 table), and an owned record admits
  only the FSM's single named owner — never looser than today, in any arm.
  A machine serving an inbound message for a topic passes by construction —
  the router only routes to the custody owner;
  (c) relaxations (machine-local, owned-scope, and any I9-audited
  absent-window opt-in on a topic-scoped entry) activate only at
  `dryRun:false`.
- **I5 Fail-closed on genuine ambiguity ONLY:** `ownership-unresolved` is
  reserved for an unwarmed index or a malformed record (one failing the §3.2
  ingest validation). A missing custody record or missing session→topic
  binding is NOT ambiguity: for `session-scoped` it is the
  machine-local-by-construction case and ADMITS (§3.2; fail toward delivery,
  "The Agent Is Always Reachable"); for `topic-scoped` it resolves
  deterministically to the legacy lease boolean (§3.2 table — a definite
  admit-or-refuse, not an unresolved state). There is no `contested` FSM
  state.
- **I6 Single-machine no-op:** no peers ⇒ admit everything; behavior
  byte-identical except observability.
- **I7 Refusals are local-knowledge:** naming the owner/lease-holder uses only
  in-memory state, staleness-tagged — a refusal can never hang on a mesh call.
- **I8 Registry-or-legacy, never neither:** an unclassified StateManager op
  defaults to `cluster-shared` (today's exact guard); an unwired route keeps
  today's exact behavior and is lint-visible. No surface silently loses its
  guard by omission.
- **I9 No machine-local without a convergence story — on BOTH axes:** every
  `machine-local` registry entry names its logical convergence story, AND any
  entry whose store sits on a git-synced shared path also names its
  file-level arm (`per-machine-path` | `git-sync-excluded`) (§3.1); a
  shared-path store missing either axis is refused the classification and
  stays `cluster-shared`. A topic-scoped entry's absent-window opt-in (§3.2
  table exception) is audited under the same schema. Enforced by the registry
  schema + a Tier-1 test, not by review vigilance.

## 5. Failure modes & fail directions

| Failure | Direction | Mechanism |
|---|---|---|
| Ownership index diverges from the local store | Impossible by construction for local state: the index is warmed by the store's own scan and updated at each substrate's own commit point (the interface-level `onCommit`, §3.2 — both `registry.cas()` and `OwnershipApplier` funnel through `store.casWrite`); a Tier-1 parity test (both substrates) guards the invariant | §3.2 |
| Local custody lags TRUE mesh custody (cross-machine propagation delay) | Accepted, bounded residual: same TOCTOU window message-routing already lives with; custody can move between admit and the store write (ms-to-tick window). Convergence: per-machine single-writer files + journal replication (`OwnershipApplier` tick) reconcile; a write admitted under just-moved custody lands in a per-machine store whose merge semantics already handle it | §3.2 clause 3; L2 disposition §11 |
| Session→topic binding unresolved (in-memory map miss) | Fail toward DELIVERY: treated as unbound ⇒ admit (per-spawn session ids give no cross-machine fork surface; refusing would gate serving an inbound — the M2 regression) | §3.2 table, session-scoped unbound arm |
| Topic-scoped write with NO custody record (pool cold-start; background sweeps over stale bindings on two machines) | Fail toward TODAY: the legacy lease boolean — admit on the holder, typed-refuse `read-only-standby` on a standby. Never two writers on one shared per-topic path (the C1 fork) | §3.2 table, topic-scoped absent arm |
| Write arrives BEFORE WriteAdmission is constructed (boot window) | Fail toward TODAY: `guardWrite` runs the legacy blanket verdict until the one-way attach, which lands before routes are wired — no HTTP route can observe the window | §3.2 pre-construction window |
| Admission layer itself throws — store seam | Fail toward TODAY: legacy blanket guard verdict (exactly the current behavior) | try/catch around `admitWrite` at the seam |
| Admission layer itself throws — route seam | Per-domain split (external finding #6): `machine-local` routes PROCEED (fail toward delivery — refusing would create a NEW outage for writes that are safe everywhere); `session-/topic-scoped` and `cluster-shared` routes refuse typed `admission-error` (fail closed — a broken guard must not enable a fork). Both directions log | §3.4 code union |
| Event loop starved (P1-A7 window) | Honest: nothing in-process can answer; the §6 loop-lag gauge records the window so a hang is ATTRIBUTABLE (starvation) instead of misfiled as an admission failure | `monitorEventLoopDelay` gauge + probe co-measurement (§8) |
| Mixed-version pair (F4 class): one machine admission-live, peer on the old blanket | Safe by construction — admission is machine-LOCAL, no wire protocol; the old peer keeps throwing its raw string errors. NAMED here per the F4 lesson (any dev-gated mesh feature halves on a mixed pair): the §6 surface reports `mode` so the pair's asymmetry is visible, and graduation (§7) requires both dev machines flipped together | no cross-machine dependency in the design |
| Refusal storm (a caller loops on 409) | Bounded: refusals are cheap (no side effects) + `Retry-After` steers generic clients + the no-busy-retry contract binds internal callers (§3.4) + per-source aggregate alerting is the tripwire; the log row carries the caller route for diagnosis | §6 dedup |
| Pool dark while writeAdmission live | Scoped domains collapse to the legacy lease boolean (refuse `read-only-standby` on a standby, admit on the holder) — byte-identical to today; machine-local still admits everywhere | §3.2 pool-inactive clause |
| Crash mid-write after admit | Unchanged from today (atomic tmp+rename writes in both stores); admission adds no new partial-write states | §3.4 refuse-before-touch |

## 6. Observability

- **`GET /write-admission`** (Bearer): `{ enabled, dryRun, mode:
  "legacy"|"dry-run"|"live", domains: [{ domain, admitted, refused,
  wouldRefuse, wouldAdmitChanged }], recentRefusals: [ring buffer ≤50, typed
  bodies minus hints], ownershipIndex: { entries, lastCasTransitionAt },
  eventLoop: { p50, p99, max, starvedWindows24h } }`. 503 when dark (house
  rule).
- **`logs/write-admission.jsonl`** — one row per refusal AND per would-verdict
  divergence in dryRun (`ts, seam: "route"|"store", op/route, domain, scope,
  verdict, code, owner, leaseHolder`) — bounded + rotated. The dryRun rows are
  the graduation evidence (§7): `wouldRefuse` on a write that today SUCCEEDS =
  a false positive to fix before `dryRun:false`; `wouldAdmit` on a write that
  today THROWS read-only = the fix landing.
- **Event-loop-lag gauge** (`perf_hooks.monitorEventLoopDelay`, ~zero cost) —
  exported on `/write-admission` and on the **AUTHED extension of `/health`
  ONLY** (the same posture as `multiMachine.syncStatus.ropeHealth`): the
  unauthenticated basic `/health` body never carries it. p50/p99/max/starved-
  windows is a live load oracle — handing it to an unauthenticated caller
  would be an outsider's timing instrument. This is the P2-6 attribution
  instrument (§1.3/§1.4) and the standing measurement P1-A7 needs anyway.
- **Guard posture:** `writeAdmission` appears in `GET /guards` via the §3.5
  `GUARD_MANIFEST` entry (dark-default classification; `on-dry-run` while
  soaking; `loadBearing:false` while the legacy guard enforces) — a load-shed
  disable is visible, never silent.
- **Aggregate alert only:** ≥N refusals of the same (route, code) within a
  window raises ONE deduped attention item; never per-event (flood lesson).
- **Admission-layer-throw occurrences join the SAME aggregate (round-2 L4,
  external r2 #2):** BOTH the fail-open machine-local proceeds AND the
  fail-closed `admission-error` refusals (§5 route-seam split) are evidence
  of a broken guard — each gets a named (route, code=`admission-error`,
  direction) aggregate row on `GET /write-admission` and rides the same
  ≥N-in-window ONE-deduped-attention-item discipline. A broken guard is never
  a log-only event, and never a flood.

## 7. Config, rollout ladder, migration

```jsonc
// .instar/config.json
"multiMachine": {
  "writeAdmission": {
    // OMITTED by default → resolveDevAgentGate: LIVE on a development agent,
    // DARK on the fleet (house Maturation Path).
    "enabled": undefined,
    "dryRun": true,        // dry-run FIRST even on dev (FD-7 telemetry pattern)
    "refusalAggregateThreshold": 5
  }
}
```

**DryRun cost semantics (explicit — external finding #7):** dryRun changes
NOTHING in execution or spend — every route and store write runs today's
exact flow (legacy guard enforcing, tone gate running, tokens spent exactly as
now); the admission verdict is computed and LOGGED only (the write-safety
canary pattern from credential-repointing). The only cost of dryRun is the
microsecond check + a log row.

Ladder (mutation-bearing → full ladder):
1. **Dark fleet / live-dev in dryRun** (ships this way): admission EVALUATES
   everything and LOGS would-verdicts; the legacy blanket guard keeps
   enforcing; zero behavior change anywhere. Soak on the dev pair (Laptop +
   Mini) collecting §6 divergence rows.
2. **`dryRun:false` on the dev pair — BOTH machines in the same deploy window**
   (the F4 mixed-pair lesson). **Gates, ALL required:**
   (a) the §3.5 write-surface inventory is COMPLETE and reviewed — every
   mutating route/op/key present in the registry (TODO-classify rows
   permitted; absent rows refuse the flip);
   (b) ≥3 days with zero `wouldRefuse`-was-wrong rows (legitimate write
   refused);
   (c) zero admitted-write fork incidents (WS2.x conflict surfaces stay
   clean);
   (d) the §8 live-proof green.
3. **Fleet default-on** in a regular release, `enabled:true` +
   `dryRun:false` defaults via `migrateConfig()` (existence-checked), after the
   dev soak; single-machine agents are unaffected at every stage (I6).

Migration parity: config default via `migrateConfig()`; no hook/skill/template
changes in wave 1 (the two wave-1 route families ADMIT everywhere — no caller
sees a new status); CLAUDE.md template gains the `GET /write-admission` +
"why did my write get a 409 naming another machine?" proactive trigger
(Agent Awareness standard); route callers that must learn 409 handling arrive
only with wave-2 classifications, each of which rides its own PR + template
note. Old-version PEERS need nothing (no wire change). `WriteRefusedError`
preserves the legacy message string for log-scraping continuity. The
`session-build-context` per-machine re-key ships inside wave 1 (§3.3) with its
one-time lease-holder cleanup of the legacy key.

**Close the Loop — named follow-ups get durable trackers at approval (round-2
L5).** A named-but-untracked follow-up is the constitution's definition of
abandoned. When this spec is approved, each of these is registered as an
evolution action (or commitment) in the same session, and the approval is not
complete until the registrations exist:
1. `write-forward-on-refusal` (§9.13 — the Phase-2 follow-up with its own
   ceremony);
2. the P1-A7 starvation-window escalation + the §8 live-proof re-run after
   any P1-A7 fix (retiring the excluded windows);
3. the `FileClassifier` sync-exclusion build item (§3.1) — it ships inside
   wave 1, but the tracker guards the case where wave 1 lands piecemeal;
4. re-classification of `corrections` (dropped from the initial table, §3.1)
   via the wave-2 inventory, with a real two-axis story.

## 8. Tests (tiers declared) + live-proof clause

- **Tier 1 (unit):** WriteAdmission verdict table (every domain × role ×
  ownership state × pool-active × dryRun — both sides of every boundary),
  specifically including: unbound session on a pool-active standby → admit;
  bound session whose topic is owned by ANOTHER machine → `not-owner` refusal
  naming it; `placing`/`transferring` records → the FSM owner admits, others
  refuse; **absent/`released` records split by domain (the C1 table):
  `session-scoped` → admit; `topic-scoped` → legacy verdict (holder admits,
  standby refuses `read-only-standby`), and admit ONLY on an entry declaring
  an I9-audited absent-window story**; pool-dark → legacy verdicts
  byte-identical (scoped refuse `read-only-standby` on standby); pre-attach
  boot window → legacy blanket verdict. Ownership index: parity with the
  store across arbitrary `cas()`/`OwnershipApplier` commit sequences, **run
  against BOTH shipped substrates (`LocalSessionOwnershipStore` AND
  `InMemorySessionOwnershipStore` — the interface-level `onCommit`
  contract)**; ingest validation (a record missing a string `ownerMachineId`
  or carrying an unknown status — e.g. one surfaced by the weakly-validated
  `all()` scan — classifies malformed ⇒ `ownership-unresolved`, never
  `not-owner` with `owner: null`); ZERO fs on the admission path (fs spied)
  including negative lookups; boot-warm completeness. Registry: exact-key kv matching
  (`session-build-context-<machineId>` → machine-local; the LEGACY
  `session-build-context` key stays cluster-shared); I9 refusal of a
  machine-local entry with no convergence story AND of a shared-git-synced-
  path entry with a logical story but no file-level arm (the two-axis rule). StateManager guardWrite
  delegation incl. legacy fallback on admission throw; journal path jail
  survives the fold-in (escape still throws when not read-only); refusal body
  schema incl. `Retry-After` on every `retryable:true`; route-seam throw
  split (machine-local proceeds / scoped+cluster-shared refuse
  `admission-error`); I2 timing (p99 <1ms over 10k calls); registry↔wiring
  identity (the map the tests read IS the map the server wires).
- **Tier 2 (integration):** `POST /evolution/actions` + `POST /attention` on a
  simulated standby-that-owns-topics → 201 (admitted, machine-local) with the
  gate still applied after admission; a `cluster-shared` route on a non-holder
  → 409 typed body + `Retry-After`, <2s, zero store mutation (I3 asserted by
  store snapshot); dryRun mode → legacy behavior + would-verdict rows +
  byte-identical spend path; admission-throw → the §5 per-seam fail
  directions.
- **Tier 3 (e2e lifecycle):** production init path constructs the registry,
  index, and routes; `GET /write-admission` answers 200 live-on-dev / 503 dark;
  guard posture row present. Burst-invariant: a refusal storm creates ≤1
  attention item.
- **Live-proof clause (the roadmap 4.3 acceptance):** on BOTH machines (Mini =
  lease holder, Laptop = pool-owning non-holder), a probe battery of
  `POST /evolution/actions` + `POST /attention` (plus one deliberately
  inadmissible cluster-shared write) — every probe **succeeds or
  typed-refuses in <2s**, measured p100 over ≥20 probes spread across ≥1h,
  with the event-loop-lag gauge co-recorded. **Attribution refinement
  (external finding #5) so a P1-A7 dependency cannot block acceptance
  indefinitely:** probes landing OUTSIDE attributable starvation windows must
  ALL pass — that is the acceptance bar for THIS feature. A probe landing
  INSIDE a starvation window (visible gauge spike co-timed with the slow
  probe) is attributed + escalated to P1-A7 with the gauge data and excluded
  from this clause; a slow probe with NO gauge spike is a REAL failure of this
  feature, full stop. The clause re-runs after any P1-A7 fix to retire the
  excluded windows.
- **Acceptance follow-through (Close the Loop):** immediately after the
  live-proof goes green on the dev pair, register the mm-audit P0/P1 findings
  ledger into the evolution queue via `POST /evolution/actions` on the Laptop
  (the machine that failed twice), resolve attention item
  `agent:mm-audit-registration-debt-2026-07`, and update fb-99ab6347 with the
  §1.4 revision + evidence.

## 9. Frontloaded decisions (complete — includes every round-1 open question)

1. **409 (not 503/423) for ALL admission refusals, including transient ones**
   — state-based conflict; 503 stays the feature-dark signature; every
   `retryable:true` refusal carries `Retry-After` so generic clients back off
   (resolves OQ5; external finding #3 contested-then-cleared).
2. **Refuse, don't proxy (wave 1 AND wave 2)** — forwarding a write is
   authority-bearing and duplicates WS4.1-style machinery; the refusal names
   the owner so the caller re-targets deliberately.
3. **Evolution + attention are `machine-local`** — both stores are per-machine
   single-writer with named convergence stories (WS2.5 replication; pool-scope
   merge + WS4.1). Admitting them everywhere IS the P2-6 fix, not a fork risk.
4. **The lease boolean survives as the cluster-shared gate** — no coordinator
   rewiring; smallest possible authority change; U4.2/U4.4 interplay untouched.
5. **Registry defaults fail toward today** (I8) — unclassified = current
   behavior + lint visibility, so partial adoption can't silently drop a guard.
6. **DryRun keeps the LEGACY guard enforcing** — the new layer gets zero
   authority until an explicit `dryRun:false`; dryRun changes nothing in
   execution or spend (§7).
7. **Event-loop instrumentation is IN scope; event-loop repair is OUT** — the
   typed-refusal guarantee is honest only if hang windows are measurable; the
   repair is P1-A7's own root-cause track. The gauge is authed-only (§6).
8. **Both dev machines flip `dryRun:false` in one window** — the F4 mixed-pair
   lesson applied prospectively.
9. **Ownership index = boot-warm + interface-level commit hook, never
   `registry.read()` on the admission path** (resolves OQ1/M1; refined by
   round-2 S4) — one synchronous `all()` scan at construction, then
   `onCommit` on the `SessionOwnershipStore` CONTRACT, fired by each shipped
   substrate at its own mutation point (Local: `persist()`; InMemory:
   `casWrite()`), covering BOTH mutation paths (`registry.cas()`,
   `OwnershipApplier`); records validated at ingest (round-2 L1); negative
   answers from memory; parity-tested against both substrates (§3.2).
10. **Unowned ⇒ machine-local-by-construction ⇒ admit — for `session-scoped`
   ONLY** (resolves M2; narrowed by round-3 C1) — no topic binding, no
   custody record, or a `released` record ADMIT for session-scoped writes;
   only a record positively naming another machine refuses. Session→topic
   comes from the in-memory topic-session binding
   (`TelegramAdapter.getTopicForSession`); a binding miss fails toward
   delivery (§3.2). The topic-scoped absent/released arm is decision 18.
11. **Admission is grounded on the FSM's single-owner guarantee** (resolves
   M5) — admit iff `ownerOf(scope) === thisMachine`, well-defined in
   `placing` and `transferring`; no F1 dependency; "contested" retired
   (there is no such FSM state).
12. **kv classification is exact-key; mixed-granularity keys are refused
   classification until split/re-keyed** (resolves OQ4) —
   `session-build-context` is re-keyed per machine as the first instance
   (resolves M3/M3-b), and every machine-local entry carries a named
   convergence story on both axes where a git-synced shared path is involved
   (I9, round-2 S1).
13. **Forward-on-refusal is the named follow-up `write-forward-on-refusal`,
   explicitly out of scope** (resolves OQ3) — its open sub-questions
   (idempotency set, whose authority the forward carries — KYP) transfer to
   that follow-up's own ceremony, not to this spec's builder.
14. **The wave-2 write-surface inventory is a build Phase-1 artifact and a
   `dryRun:false` ladder gate** (resolves OQ2; external finding #2) — the flip
   is refused while any mutating surface is absent from the registry (§3.5,
   §7).
15. **The admission check runs first in every mode; refusal authority arrives
   only at `dryRun:false`** (resolves OQ6) — no reorder event, no dry-mode
   behavior change, decision-log thinning only on actually-refused sends.
16. **Route-seam failure splits by domain; store seam falls back to legacy**
   (external finding #6) — machine-local proceeds (fail toward delivery),
   scoped/cluster-shared refuse typed `admission-error` (fail closed).
17. **Pool-dark collapses scoped domains to the legacy lease boolean**
   (resolves S5) — byte-identical to today's standby behavior; machine-local
   admits everywhere regardless.
18. **Topic-scoped absent/released ⇒ the legacy lease boolean, NOT admit**
   (resolves round-2 C1; folds external r2 #1) — the two scoped domains'
   absent arms diverge because their today-baselines diverge: session-scoped
   admit-on-absent is today-equivalent (the carve-out), topic-scoped
   admit-on-absent would be a LOOSENING (today every topic-keyed kv write
   refuses on every non-holder) and a dual-writer fork surface. Default:
   legacy boolean (I4 by construction). A registry entry may opt into
   admit-on-absent only by declaring an explicit absent-window convergence
   story, I9-audited on both axes (§3.2 decision table).
19. **The `releasedEvictionMs` eviction is a declared-but-unimplemented dead
   knob** (resolves round-2 S3) — no spec argument may cite it as an active
   mechanism; neither admission arm needs it (§3.2 released-arm grounding
   correction).

## 10. Open questions

**None.** Every round-1 open question (OQ1-OQ6) is resolved into the spec body
(§3.2, §3.3, §3.4, §3.5, §7) and summarized in §9; every round-2 finding is
resolved likewise (C1 → §3.2 decision table + §9.18; S1-S4, L1-L5 → §12). The
disposition trails are §11/§12 and the round reports
(`docs/specs/reports/standby-write-reconciliation-round{1,2}-findings.md`).

## 11. Round-1 findings disposition (revision history, round 2)

Round 1 reviewed the 8afd02e0a draft (report:
`docs/specs/reports/standby-write-reconciliation-round1-findings.md`; verdict
NOT CONVERGED — 5 MUST-FIX, 9 SHOULD-FIX, 6 LOW, incl. 7 dispositioned
external gemini findings). This round-2 revision folds ALL of them; zero
rejected; one external finding (#3, 503-vs-409) resolved differently than
proposed, with the rationale recorded in §9.1.

| finding | disposition | where |
|---|---|---|
| M1 (OQ1 load-bearing; I2 unsatisfiable vs the real store) | Adopted — ownership index decided: boot-warm `all()` + `onCommit` at the store funnel covering both mutation paths; `registry.read()` banned from the admission path | §3.2, §9.9, §8 parity/fs tests |
| M2 (unowned-session regression; reachability) | Adopted — unowned/unbound/released ⇒ machine-local-by-construction ⇒ admit; binding source named (in-memory topic-session registry); binding miss fails toward delivery | §3.2, I4-b, I5, §9.10 |
| M3 + M3-b (wrong kv key; shared git-synced file forks) | Adopted — exact key `session-build-context` corrected everywhere; store re-keyed `session-build-context-<machineId>` (machine-local, per-machine-path story); legacy key inert + lease-holder cleanup; generalized to I9 (no machine-local without a convergence story) | §1.1, §3.3, §3.1, I9, §9.12 |
| M4 (six open questions left to the builder) | Adopted — OQ2-OQ6 each resolved to a frontloaded decision; §10 emptied | §9.13-9.15, §9.1, §9.14, §10 |
| M5 (blanket fail-closed on `placing` + F1 dependency) | Adopted — admission grounded on the FSM single-owner guarantee (`ownerOf` well-defined in placing/transferring); no F1 dependency; "contested" retired | §3.2 rule 3, I5, §9.11 |
| S1 (evolution filename) | **Mis-diagnosed in round 1** — the round-1 finding itself was wrong (`addAction` writes `state/evolution/action-queue.json`; `evolution-queue.json` is the distinct proposals store). The round-2 fold faithfully applied the error; round 3 reverts it with the real call chain cited (round-2 S2) | §1.2, §12 |
| S2 (loop gauge = load oracle on unauth /health) | Adopted — gauge rides the AUTHED /health extension only (ropeHealth posture) | §6 |
| S3 (parent-doc paths don't resolve in-repo) | Adopted — qualified as agent-home session-A workspace docs | frontmatter `parent-spec` |
| S4 (guard-manifest entry implied, not deliverable) | Adopted — GUARD_MANIFEST entry named with key/kind/configPath/dryRunConfigPath/process/loadBearing | §3.5, §6 |
| S5 (pool-dark × writeAdmission-enabled unstated) | Adopted — scoped domains collapse to the legacy lease boolean; machine-local unaffected | §3.2, §5 row, §9.17 |
| S6 (P19 caller-retry brakes) | Adopted — `Retry-After` on every retryable refusal; no-busy-retry contract for internal callers; aggregate alert as tripwire | §3.4, §5 refusal-storm row |
| S7 (session- vs topic-scoped keying honesty) | Adopted — one topic-keyed index, two key derivations; session→topic source named; resolution is the caller's job | §3.1 keying note |
| L1 (Telegram abort precision) | Adopted — 15s (60s for long-poll getUpdates) | §1.3 |
| L2 (TOCTOU residual) | Adopted — accepted residual named with its convergence mechanism | §5 cross-machine-lag row |
| L3 (journal jail must survive fold-in) | Adopted — jail survives verbatim, stated + tested | §3.1, §3.6, §8 |
| L4 (refusal hint reads as instruction) | Adopted — hint is advisory prose, never a runnable command; consent-gating named | §3.4 |
| L5 (record :52 vs kv write :105 conflated) | Adopted — cites corrected | §1.1 |
| ext #1 (placing-stuck refusals) | Duplicate of M5 — folded there | §3.2, §9.11 |
| ext #2 (inventory before dryRun:false) | Adopted — ladder gate (a) on stage 2 | §3.5, §7 |
| ext #3 (503+Retry-After) | Contested-then-cleared — 409 kept uniformly, `Retry-After` adopted; 503 rejected as the feature-dark signature | §3.4, §9.1 |
| ext #4 (prefix matching too coarse) | Adopted — exact-key wave 1; mixed keys refused classification | §3.3, §9.12 |
| ext #5 (P1-A7 can block acceptance) | Adopted — starvation-window probes attributed + escalated + excluded; no-spike slow probe = real failure | §8 live-proof |
| ext #6 (route-seam throw fallback fail-open) | Adopted with per-domain split — machine-local proceeds; scoped/shared refuse `admission-error` | §3.4, §5, §9.16 |
| ext #7 (dryRun cost semantics) | Adopted — dryRun changes nothing in execution or spend; log-only | §7 |

## 12. Round-2 findings disposition (revision history, round 3)

Round 2 reviewed the 6beb99302 revision (report:
`docs/specs/reports/standby-write-reconciliation-round2-findings.md`; verdict
NOT CONVERGED — 1 MUST-FIX, 4 SHOULD-FIX, 5 LOW, incl. 2 dispositioned
external gemini findings). This round-3 revision folds ALL of them; zero
rejected.

| finding | disposition | where |
|---|---|---|
| C1 (topic-scoped absent⇒admit contradicts I4; folds external r2 #1) | Adopted — the scoped-domain rule is now ONE decision table split by domain: session-scoped absent/released ⇒ admit (today-equivalent, the M2 case); topic-scoped absent/released ⇒ the legacy lease boolean (byte-identical to today — I4 by construction), with an explicit I9-audited absent-window-story opt-in as the only exception. I4(b) restated per-domain against each domain's own today-baseline | §3.2 decision table, §3.1 table, §3.3, I4(b), I5, §5 new row, §8, §9.10, §9.18 |
| S1 (I9 conflates logical vs file-level convergence; wave-1 machine-local entries sit on git-synced shared paths) | Adopted — I9 gains a second axis (file-level arm `per-machine-path` \| `git-sync-excluded` required for any shared git-synced path); concrete wave-1 build item adds `.instar/state/attention-items.json` + `.instar/state/evolution/` to FileClassifier sync exclusions; WS2.5 story honesty stated (action-queue only; dark on fleet); `corrections` DROPPED from the table until it has a real story; "unrepresentable" softened to refusable+lint-checkable | §3.1 (table + two-axis paragraph), I9, §7 follow-ups, §8 |
| S2 (§1.2 store identification wrong — round-1 S1 was itself mis-diagnosed) | Adopted — `POST /evolution/actions` writes `state/evolution/action-queue.json` (`addAction` :1245 → `loadActions`/`saveActions` :1167/:1174 → `readFile`/`writeFile('action-queue')` :1168/:1201); the proposals store named as distinct; §11's round-1 S1 row re-marked mis-diagnosed; §8 probes pointed at the right file | §1.2, §11 S1 row |
| S3 (`releasedEvictionMs` cited as active but declared-and-unused) | Adopted — named a dead knob (do not re-cite); session-scoped released⇒admit re-grounded on today-equivalence alone; topic-scoped released⇒legacy-boolean needs no eviction argument | §3.2 released-arm grounding correction, §9.19 |
| S4 (`onCommit` must live at the store INTERFACE, not only LocalSessionOwnershipStore.persist) | Adopted — hook specified on the `SessionOwnershipStore` contract; each substrate fires at its mutation point (InMemory has no `persist()` funnel); the near-benign InMemory combination named as emergent, not a guarantee; parity test runs against BOTH substrates | §3.2 index point 2, §8, §9.9 |
| L1 (`all()` vs `loadOne()` validation asymmetry poisons the warm scan) | Adopted — index validates at ingest (string `ownerMachineId` + known status); malformed ⇒ fail-closed `ownership-unresolved` regardless of store path | §3.2 index point 4, I5, §8 |
| L2 (pre-construction window unstated) | Adopted — legacy blanket verdict until the one-way attach, which lands before routes are wired | §3.2 pre-construction window, §5 new row, §8 |
| L3 (re-key machine-id source + null fallback unnamed) | Adopted — coordinator/mesh identity (NOT the caller-less `StateManager.setMachineId`); fallback literal `local` on identity-less installs | §3.3 |
| L4 (admission-error should join the §6 aggregate; external r2 #2) | Adopted — named (route, code, direction) aggregate rows + the same deduped attention-item discipline, both fail directions | §6 |
| L5 (named follow-ups lack durable trackers) | Adopted — approval-time registration of the four named follow-ups as evolution actions/commitments; approval incomplete without them | §7 Close the Loop |
