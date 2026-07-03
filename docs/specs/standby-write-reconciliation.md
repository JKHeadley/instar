---
title: "Standby-Write Reconciliation + Typed Refusal — ownership-scoped write admission for the active-active pool (P2-6 / F9)"
slug: "standby-write-reconciliation"
author: "echo"
status: "draft (round-2 revision — all round-1 findings folded; see §11 disposition)"
eli16-overview: "standby-write-reconciliation.eli16.md"
parent-principle: "A Refusal Stays a Refusal — a write the server cannot complete returns an immediate typed refusal or a bounded error, never an open-ended hang"
sibling-principles: "Structure > Willpower; Verify the State, Not Its Symbol; Signal vs Authority; Maturation Path — Every Feature Ships Enabled on Developer Agents; Bounded Blast Radius; User Experience Is the Product (a hung write is an unreachable agent); The Agent Is Always Reachable (an unowned local session's writes must never gate on pool custody)"
parent-spec: "docs/roadmaps/instar-two-goal-roadmap-2026-07.md §4.3; docs/audits/mm-current-state-2026-07.md (F9, P2-6); docs/audits/multi-machine-seamless-ux-audit-2026-07.md §6 — NOTE: these three live in the operating agent's home workspace (session-A docs), NOT in this repo; a repo reader should not chase these paths here"
project: "session-a-phase-4.3 (topic 29836)"
depends-on: "StateManager read-only guard (src/core/StateManager.ts:102-139) + sessionScoped carve-out (standby-pool-session-writes.md); MultiMachineCoordinator role/lease reconciliation (src/core/MultiMachineCoordinator.ts:1181-1200); session-pool CAS custody (MULTI-MACHINE-SESSION-POOL-SPEC.md); SessionOwnership FSM + SessionOwnershipRegistry/LocalSessionOwnershipStore (src/core/SessionOwnership.ts, src/core/SessionOwnershipRegistry.ts, src/core/LocalSessionOwnershipStore.ts); U4.3 typed-refusal contract (u4-3-breaker-recovery-probe.md — a TYPED refusal is distinguishable from success AND from garbage); WS2.5 evolution-actions replication (ws25-evolution-actions-replication.md); WS4.1 durable remote-ack (prior art for owner-routed attention mutation)"
upstream-feedback: "fb-99ab6347 (POST /evolution/actions hangs; hypothesis revised by this spec's grounding — see §1.4)"
review-convergence: null   # round 2 in flight — has not converged
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
  `writeFile` — **plain synchronous fs to
  `state/evolution/evolution-queue.json`** (`EvolutionManager.filePath` `:747`;
  `loadEvolution`/`saveEvolution` name `'evolution-queue'`, `:782/:813`),
  bypassing StateManager entirely.
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
| `machine-local` | This machine's own single-writer store; cross-machine convergence is handled by the entry's **named convergence story** (see below) | **Admit on every machine, always** — lease-irrelevant, pool-state-irrelevant | evolution stores (`state/evolution/*` — convergence: WS2.5 replication), attention items (`state/attention-items.json` — convergence: pool-scope GET merge + WS4.1 ack), learnings (WS2.2), knowledge (WS2.4), corrections, coherence-journal own streams (the existing `guardJournalWrite` allowlist folds in unchanged, **including its path jail** — the prefix check at `StateManager.ts:162-171` that throws on any path escaping the journal root even when NOT read-only survives the refactor verbatim), **`SessionBuildContextStore` under its per-machine re-key (§3.3 — convergence: per-machine key, single-writer per file)** |
| `session-scoped` | State keyed to ONE session, whose owning machine is determined by pool custody (via the session's topic binding — see keying note below) | Admit per the §3.2 scoped-domain rule: unbound or no custody record ⇒ machine-local-by-construction ⇒ admit; custody record present ⇒ admit iff FSM owner = this machine | `saveSession`/`removeSession` (`StateManager.ts:203/:369` — today's `sessionScoped` carve-out generalizes into this rule) |
| `topic-scoped` | State keyed to ONE topic; owner = the pool custody record for `String(topicId)` | Same §3.2 rule, scope key = the topic id directly | topic profiles, topic intent, per-topic resume UUIDs (full inventory is the wave-2 grounding artifact — §3.5, ladder gate §7) |
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

**Convergence-story requirement (structural, not advisory).** Every
`machine-local` registry entry MUST carry a named convergence story, one of:
`ws2x-replicated` | `pool-scope-read-merge` | `per-machine-path` (the file
path or kv key embeds the machine id — single writer per file by construction)
| `git-sync-excluded` (listed in `FileClassifier` sync exclusions,
`src/core/FileClassifier.ts:121-151`) | `ephemeral-rebuildable`. A
shared-path store with NO story is **refused classification** and stays
`cluster-shared` (I8/I9) — this is the generalized M3-b lesson: admitting a
shared git-synced file on every machine manufactures recurring merge
conflicts; the registry schema makes that unrepresentable.

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
2. **Transition hook at the single mutation funnel:** the store gains an
   `onCommit(record)` callback fired inside `persist()` (after `cache.set`,
   `:81-95`). BOTH mutation paths funnel through it — `registry.cas()` →
   `store.casWrite` → `persist` (`SessionOwnershipRegistry.ts:159-180`), AND
   `OwnershipApplier` materializing replicated journal placements via the SAME
   `store.casWrite` (`src/core/OwnershipApplier.ts` header contract). There is
   no third writer; the index can never miss a transition the local store saw.
3. **Parity by construction:** the index mirrors the store's in-memory cache
   exactly (asserted by a Tier-1 parity test over arbitrary cas/applier
   sequences). Cross-machine staleness — the local store lagging true mesh
   custody until the next `OwnershipApplier` tick — is the accepted §5 TOCTOU
   residual, identical to the window message-routing already lives with.
4. Until the boot warm completes, scoped-domain verdicts are
   `ownership-unresolved` (fail closed, `retryable:true`); the warm is
   synchronous at construction so the window is one boot instant.
   The `InMemorySessionOwnershipStore` (dev-gate-off substrate) is trivially
   covered (its `all()` is already pure memory).

**The scoped-domain admission rule (decided — was M2 + M5).** For
`session-scoped` / `topic-scoped` writes, **when the session pool is active**
(`_sessionPoolActive`, set at `src/commands/server.ts:19525`):

1. Resolve scope → topic key (§3.1 keying note). A session with NO topic
   binding (locally-spawned job / headless / lifeline sessions — never pooled)
   is **UNBOUND** ⇒ no pool custody scope can exist for it ⇒ the write is
   **machine-local-by-construction ⇒ ADMIT**. A binding-resolution miss (the
   in-memory map lacks an entry that might exist on disk) is treated as
   UNBOUND ⇒ ADMIT: per-session files are keyed by per-spawn session ids (no
   cross-machine fork surface), and refusing here would gate serving an
   inbound message on a standby — the exact "Agent Is Always Reachable"
   regression this rule exists to prevent.
2. Topic key resolved ⇒ index lookup. **No record, or record
   `status:'released'`** ⇒ ADMIT (machine-local-by-construction). Released ≡
   absent by eviction-consistency: `releasedEvictionMs` deletes released
   records after 24h (`SessionOwnershipRegistry.ts:91`), so refusing on
   `released` would silently change behavior at eviction time.
3. **Record in `placing` / `active` / `transferring`** ⇒ ADMIT iff
   `record.ownerMachineId === thisMachineId`, else refuse `not-owner` naming
   the owner. This is grounded on the FSM's own single-owner guarantee: the
   FSM names exactly ONE machine in every non-released state —
   `ownerOf` returns `ownerMachineId` for all three
   (`SessionOwnershipRegistry.ts:133-138`); `placing` names the placed owner,
   `transferring` names the draining source until the target's claim lands
   (`placementTargetOf`, `:144-150`, distinguishes the target; the
   output-exclusion contract in `SessionOwnership.ts` already governs who acts
   during a transfer). Consequence for the known F1 `placing`-wedge topics:
   the placed owner KEEPS its writes (ownerOf names it) — this spec has **no
   dependency on the F1 fix** and never turns a wedged placement into a
   permanent owner-write refusal. There is no `contested` state in the FSM
   (custody is a committed CAS record); the round-1 draft's
   "placing/contested → refuse" is retired.
4. `ownership-unresolved` (fail closed, retryable) is reserved for genuine
   ambiguity ONLY: index not yet warm, or a structurally malformed record.

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

### 3.3 D3 — StateManager re-scope: the boolean becomes one domain's input

`guardWrite(operation, opts)` gains a resolved domain (from the registry, by op
name + optional key) and delegates:

- `machine-local` → pass (even when `_readOnly`).
- `session-scoped` / `topic-scoped` → the §3.2 scoped-domain rule (the
  existing `sessionScoped && _sessionPoolActive` carve-out generalizes into
  it; see I4-b for the exact tightening/loosening honesty).
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
`FileClassifier`'s sync exclusions (`src/core/FileClassifier.ts:121-151`) and
`GitSyncManager` auto-commit+push is constructed for both roles on git-backed
mesh machines (`src/commands/server.ts:4548`). Admitting that write on every
pool machine would have two machines rewriting the SAME file continuously —
recurring merge conflicts routed to the LLM conflict resolver. So wave 1
**re-keys the store per machine**: `session-build-context-<machineId>` (the
machine id charset-jailed to `[A-Za-z0-9_-]` before embedding, mirroring the
`sessionFileName` jail in `LocalSessionOwnershipStore.ts:35-39`, so
`validateKey` always passes). Each machine reads and writes ONLY its own key —
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
  (b) the session-scoped carve-out is tightened EXACTLY where a fork is
  possible and nowhere else: today's pool-active blanket admits every
  session write on a standby; the new rule keeps admitting unbound /
  no-record / released scopes (machine-local-by-construction — the M2
  reachability guarantee) and refuses ONLY a scope whose custody record
  positively names ANOTHER machine (the double-run/fork case). A machine
  serving an inbound message for a topic passes by construction — the router
  only routes to the custody owner;
  (c) relaxations (machine-local, owned-scope) activate only at `dryRun:false`.
- **I5 Fail-closed on genuine ambiguity ONLY:** `ownership-unresolved` is
  reserved for an unwarmed index or a malformed record. A missing custody
  record or missing session→topic binding is NOT ambiguity — it is the
  machine-local-by-construction case and ADMITS (§3.2; fail toward delivery,
  "The Agent Is Always Reachable"). There is no `contested` FSM state.
- **I6 Single-machine no-op:** no peers ⇒ admit everything; behavior
  byte-identical except observability.
- **I7 Refusals are local-knowledge:** naming the owner/lease-holder uses only
  in-memory state, staleness-tagged — a refusal can never hang on a mesh call.
- **I8 Registry-or-legacy, never neither:** an unclassified StateManager op
  defaults to `cluster-shared` (today's exact guard); an unwired route keeps
  today's exact behavior and is lint-visible. No surface silently loses its
  guard by omission.
- **I9 No machine-local without a convergence story:** every `machine-local`
  registry entry names its convergence story (§3.1); a shared-path store
  without one is refused the classification and stays `cluster-shared`.
  Enforced by the registry schema + a Tier-1 test, not by review vigilance.

## 5. Failure modes & fail directions

| Failure | Direction | Mechanism |
|---|---|---|
| Ownership index diverges from the local store | Impossible by construction for local state: the index is warmed by the store's own scan and updated at the store's single mutation funnel (`persist` onCommit — both `registry.cas()` and `OwnershipApplier` pass through it); a Tier-1 parity test guards the invariant | §3.2 |
| Local custody lags TRUE mesh custody (cross-machine propagation delay) | Accepted, bounded residual: same TOCTOU window message-routing already lives with; custody can move between admit and the store write (ms-to-tick window). Convergence: per-machine single-writer files + journal replication (`OwnershipApplier` tick) reconcile; a write admitted under just-moved custody lands in a per-machine store whose merge semantics already handle it | §3.2 clause 3; L2 disposition §11 |
| Session→topic binding unresolved (in-memory map miss) | Fail toward DELIVERY: treated as unbound ⇒ admit (per-spawn session ids give no cross-machine fork surface; refusing would gate serving an inbound — the M2 regression) | §3.2 rule 1 |
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

## 8. Tests (tiers declared) + live-proof clause

- **Tier 1 (unit):** WriteAdmission verdict table (every domain × role ×
  ownership state × pool-active × dryRun — both sides of every boundary),
  specifically including: unbound session on a pool-active standby → admit;
  bound session whose topic is owned by ANOTHER machine → `not-owner` refusal
  naming it; `placing`/`transferring` records → the FSM owner admits, others
  refuse; absent/`released` records → admit; pool-dark → legacy verdicts
  byte-identical (scoped refuse `read-only-standby` on standby). Ownership
  index: parity with the store across arbitrary `cas()`/`OwnershipApplier`
  commit sequences; ZERO fs on the admission path (fs spied) including
  negative lookups; boot-warm completeness. Registry: exact-key kv matching
  (`session-build-context-<machineId>` → machine-local; the LEGACY
  `session-build-context` key stays cluster-shared); I9 refusal of a
  machine-local entry with no convergence story. StateManager guardWrite
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
9. **Ownership index = boot-warm + store-funnel hook, never `registry.read()`
   on the admission path** (resolves OQ1/M1) — one synchronous `all()` scan at
   construction, then `onCommit` at the `LocalSessionOwnershipStore.persist`
   chokepoint that BOTH mutation paths (`registry.cas()`, `OwnershipApplier`)
   funnel through; negative answers from memory; parity-tested (§3.2).
10. **Unowned ⇒ machine-local-by-construction ⇒ admit** (resolves M2) — no
   topic binding, no custody record, or a `released` record all ADMIT; only a
   record positively naming another machine refuses. Session→topic comes from
   the in-memory topic-session binding (`TelegramAdapter.getTopicForSession`);
   a binding miss fails toward delivery (§3.2).
11. **Admission is grounded on the FSM's single-owner guarantee** (resolves
   M5) — admit iff `ownerOf(scope) === thisMachine`, well-defined in
   `placing` and `transferring`; no F1 dependency; "contested" retired
   (there is no such FSM state).
12. **kv classification is exact-key; mixed-granularity keys are refused
   classification until split/re-keyed** (resolves OQ4) —
   `session-build-context` is re-keyed per machine as the first instance
   (resolves M3/M3-b), and every machine-local entry carries a named
   convergence story (I9).
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

## 10. Open questions

**None.** Every round-1 open question (OQ1-OQ6) is resolved into the spec body
(§3.2, §3.3, §3.4, §3.5, §7) and summarized in §9; the disposition trail is
§11 and the round-1 findings report
(`docs/specs/reports/standby-write-reconciliation-round1-findings.md`).

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
| S1 (evolution filename) | Adopted — `state/evolution/evolution-queue.json` | §1.2 |
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
