---
title: "Standby-Write Reconciliation + Typed Refusal — ownership-scoped write admission for the active-active pool (P2-6 / F9)"
slug: "standby-write-reconciliation"
author: "echo"
status: "draft"
parent-principle: "A Refusal Stays a Refusal — a write the server cannot complete returns an immediate typed refusal or a bounded error, never an open-ended hang"
sibling-principles: "Structure > Willpower; Verify the State, Not Its Symbol; Signal vs Authority; Maturation Path — Every Feature Ships Enabled on Developer Agents; Bounded Blast Radius; User Experience Is the Product (a hung write is an unreachable agent)"
parent-spec: "docs/roadmaps/instar-two-goal-roadmap-2026-07.md §4.3; docs/audits/mm-current-state-2026-07.md (F9, P2-6); docs/audits/multi-machine-seamless-ux-audit-2026-07.md §6"
project: "session-a-phase-4.3 (topic 29836)"
depends-on: "StateManager read-only guard (src/core/StateManager.ts:102-139) + sessionScoped carve-out (standby-pool-session-writes.md); MultiMachineCoordinator role/lease reconciliation (src/core/MultiMachineCoordinator.ts:1181-1200); session-pool CAS custody (MULTI-MACHINE-SESSION-POOL-SPEC.md); U4.3 typed-refusal contract (u4-3-breaker-recovery-probe.md — a TYPED refusal is distinguishable from success AND from garbage); WS2.5 evolution-actions replication (ws25-evolution-actions-replication.md); WS4.1 durable remote-ack (prior art for owner-routed attention mutation)"
upstream-feedback: "fb-99ab6347 (POST /evolution/actions hangs; hypothesis revised by this spec's grounding — see §1.4)"
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
cluster-shared) and admitted by a synchronous in-memory check — and gives every
inadmissible write a **typed, machine-readable refusal in <2s**, never a hang.
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

`SessionBuildContextStore.record` (`src/core/SessionBuildContextStore.ts:105`)
is a per-session write for a session THIS machine owns and is serving — blocked
by the blanket boolean because it routes through the kv `set` (a "shared" op by
default). Every added machine is a standby-shaped writer-that-can't-write
(mm-current-state §D.5): the model cannot scale past N=2 because N−1 machines
are write-crippled for state they own.

### 1.2 There is no refusal layer — most mutating routes never consult ANY write gate

Neither route in the P2-6 family touches the read-only guard at all:

- `POST /evolution/actions` (`src/server/routes.ts:18012`) →
  `EvolutionManager.addAction` (`src/core/EvolutionManager.ts:1245`) →
  `writeFile` (`:761`) — **plain synchronous fs to
  `state/evolution/action-queue.json`**, bypassing StateManager entirely.
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
- Every Telegram API call aborts at 15s:
  `TelegramAdapter.apiCall` (`src/messaging/TelegramAdapter.ts:5362-5364`,
  `AbortController` + `setTimeout(abort, 15_000)`).
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
  caller re-targets). Forward-on-refusal is a tracked Phase-2 follow-up (§10 OQ3).
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
| `machine-local` | This machine's own single-writer store; cross-machine convergence (if any) is handled by WS2.x replication or pool-scope read merges | **Admit on every machine, always** — lease-irrelevant | evolution stores (`state/evolution/*`, WS2.5-replicated), attention items (`state/attention-items.json`, pool-scope GET merges + WS4.1 ack), learnings (WS2.2), knowledge (WS2.4), corrections, coherence-journal own streams (existing `guardJournalWrite` allowlist folds in unchanged) |
| `session-scoped` | State keyed to ONE session, whose owner is CAS-determined by the pool | Admit iff this machine owns the session (generalizes the existing `sessionScoped` carve-out, `StateManager.ts:123-139`) | `saveSession`/`removeSession` (already carved out); **`SessionBuildContextStore` kv writes (`build-context` key — the live F9 error line, §1.1)** |
| `topic-scoped` | State keyed to ONE topic, owner = pool custody record | Admit iff this machine owns the topic (fail closed on `placing`/contested — I5) | topic profiles, topic intent, per-topic resume UUIDs (initial classification audit in build Phase 1 — §10 OQ2) |
| `cluster-shared` | Genuinely shared cluster state; single-writer = lease holder | Admit iff this machine holds the serving lease — **byte-identical to today** | lease records, job schedule state (`saveJobState`), kv `set`/`delete` (default for unclassified keys), `appendEvent` |

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
- **Synchronous and in-memory only.** No fs, no network, no LLM, no await. It
  reads (a) the lease view the coordinator already maintains in memory, (b) an
  in-memory ownership index maintained by the session pool's custody layer
  (updated on every CAS transition; the pool already holds this state to route
  messages), (c) the domain registry (§3.5). Answer time is microseconds — the
  <2s SLO is met by construction whenever the loop is alive.
- **Fail-closed on ambiguity** (I5): unknown/`placing`/contested ownership for a
  scoped domain → refuse with `code: "ownership-unresolved"`, `retryable: true`.
  A genuinely-empty ownership index on a single-machine agent admits (no peers
  ⇒ nothing to fork — I6).
- Consumed at BOTH seams:
  1. **Route seam:** mutating routes call it FIRST (§3.4).
  2. **Store seam:** `StateManager.guardWrite` delegates to it (§3.3) so
     non-HTTP writers (SessionManager, schedulers) get the same verdicts.

### 3.3 D3 — StateManager re-scope: the boolean becomes one domain's input

`guardWrite(operation, opts)` gains a resolved domain (from the registry, by op
name + optional key/prefix) and delegates:

- `machine-local` → pass (even when `_readOnly`).
- `session-scoped` / `topic-scoped` → pass iff owned (the existing
  `sessionScoped && _sessionPoolActive` carve-out becomes "the ownership index
  confirms this machine owns `<scope>`" — strictly tighter than today's
  pool-active blanket, see I4-b).
- `cluster-shared` → pass iff NOT `_readOnly` (byte-identical to today).

`setReadOnly` keeps its name and callers (`MultiMachineCoordinator` unchanged at
`:446/:544/:578/:1190`) but its semantics narrow to "the cluster-shared domain
gate". kv classification is by key prefix in the registry (first entry:
`build-context` → `session-scoped`, scope = the session the key embeds).
A refused store-seam write throws a `WriteRefusedError` carrying the
`TypedWriteRefusal` — callers that today catch-and-log the string keep working
(the message is preserved), and route handlers map it to the §3.4 wire shape.

### 3.4 D4 — Typed-refusal contract (the U4.3 contract, applied to writes)

A refusal is TYPED: distinguishable from success, from a crash, and from
garbage (u4-3 §G4 canary lesson: an untyped 2xx means nothing). Wire shape:

```json
HTTP 409
{
  "error": "write-refused",
  "code": "not-owner" | "lease-required" | "ownership-unresolved" | "read-only-standby",
  "domain": "topic-scoped",
  "scope": { "topicId": 30193 },
  "thisMachine": { "machineId": "…", "nickname": "the laptop" },
  "owner": { "machineId": "…", "nickname": "the mini" } | null,
  "leaseHolder": "…" | null,
  "asOf": "2026-07-02T21:40:00Z",
  "retryable": true,
  "hint": "This write belongs to 'the mini'. Re-send it there, or move the topic first (POST /pool/transfer)."
}
```

Contract clauses:
- **409** for admission refusals (state-based conflict; 503 stays reserved for
  feature-dark, 400 for validation, 408 for the existing budget backstop).
- `owner`/`leaseHolder` come from LOCAL knowledge only, staleness-tagged via
  `asOf` — the refusal itself never makes a mesh call (I7).
- **Refuse-before-touch** (I3): admission runs BEFORE any store write, any
  Telegram send, any gate call — a refused `POST /attention` has created no
  topic, persisted no item, spent no LLM tokens. A refusal stays a refusal.
- **Bounded-before-expensive** (I1): on mutating routes the admission check is
  the FIRST await-free statement after body validation. Nothing slow can run
  ahead of the answer.
- The refusal is logged (§6) and NEVER auto-escalated per-event (no attention
  item per refusal — the 2026-05-22 flood lesson; a persistent refusal pattern
  surfaces as ONE deduped aggregate, §6).

### 3.5 D5 — Domain registry + route-seam wiring + conformance ratchet

- A central `WriteDomainRegistry` (data, not scattered constants): StateManager
  op names, kv key prefixes, and HTTP route prefixes → domain + scope
  extractor. Single source of truth; tests assert against the SAME map the
  server wires (the PR-#334 dead-code lesson).
- **Route wiring, wave 1 (this spec):** the P2-6 family — `POST/PATCH
  /evolution/*` (`machine-local`), `POST/PATCH /attention*` (`machine-local`),
  plus the store-seam classifications in §3.1's table. Both wave-1 route
  families are `machine-local` ⇒ **admit everywhere** — the user-visible fix
  for P2-6 is that these writes are admitted (and now instrumented), while the
  refusal machinery is proven by the store seam + tests, ready for wave 2.
- **Wave 2 (follow-up, same registry):** topic-scoped routes
  (`/topic-profile`, `/mcp/*`, per-topic autonomous state) get real
  cross-machine refusals. Enumerated in the registry as `TODO-classify` so the
  lint counts them.
- **Conformance ratchet:** a lint sweep (the standards-enforcement pattern)
  flags any `router.post|patch|delete` in routes.ts with neither a registry
  entry nor an explicit `@write-domain:none` annotation (read-only actions,
  pure-compute triggers). Baseline recorded at build time; the count may only
  go DOWN (no new undeclared mutating routes).

### 3.6 D6 — What does NOT change

- WS2.x replication emitters, tombstones, fingerprints: untouched (the domain
  model is exactly why machine-local writes are safe — replication already owns
  convergence).
- The lease, its fencing, `pollFollowsLease`, U4.2/U4.4: untouched. This spec
  neither moves the lease nor changes who serves.
- The tone gate on `POST /attention`: unchanged semantics, now strictly AFTER
  admission.
- Single-machine agents: strict no-op (every domain admits; no refusal is ever
  emitted; the only observable delta is the §6 surfaces existing).

## 4. Invariants

- **I1 Bounded-before-expensive:** no mutating route performs unbounded or
  expensive work (LLM, network, large I/O) before admission has answered.
- **I2 Admission is sync + in-memory:** `admitWrite` never does I/O/network/LLM;
  p99 < 1ms under test.
- **I3 Refusal mutates nothing:** a refused write leaves zero durable trace
  besides its log row — no partial topic creation, no store write, no send.
- **I4 Fork-safety never weakens:**
  (a) `cluster-shared` on a non-holder refuses in EVERY mode — including
  dryRun, where the LEGACY blanket guard keeps enforcing while the new layer
  only logs would-verdicts;
  (b) the session-scoped carve-out gets STRICTER than today (per-session
  ownership confirmation replaces the pool-active blanket);
  (c) relaxations (machine-local, owned-scope) activate only at `dryRun:false`.
- **I5 Fail-closed on ambiguous ownership:** unknown/`placing`/contested scope
  → typed refusal (`ownership-unresolved`, retryable), never an admit-and-fork.
- **I6 Single-machine no-op:** no peers ⇒ admit everything; behavior
  byte-identical except observability.
- **I7 Refusals are local-knowledge:** naming the owner/lease-holder uses only
  in-memory state, staleness-tagged — a refusal can never hang on a mesh call.
- **I8 Registry-or-legacy, never neither:** an unclassified StateManager op
  defaults to `cluster-shared` (today's exact guard); an unwired route keeps
  today's exact behavior and is lint-visible. No surface silently loses its
  guard by omission.

## 5. Failure modes & fail directions

| Failure | Direction | Mechanism |
|---|---|---|
| Ownership index stale (custody moved, index lagging) | Fail closed (refuse `ownership-unresolved`) for scoped domains; the caller retries (`retryable:true`) after the index converges | Index updated on CAS transitions; staleness beyond a bound flips scoped verdicts to unresolved rather than guessing |
| Admission layer itself throws | Fail toward TODAY's behavior: store seam falls back to the legacy blanket guard verdict; route seam lets the route proceed as if unwired (and logs) — a broken NEW guard must not create a NEW outage (the permission-floor lesson) | try/catch at both seams around `admitWrite` |
| Event loop starved (P1-A7 window) | Honest: nothing in-process can answer; the §6 loop-lag gauge records the window so a hang is ATTRIBUTABLE (starvation) instead of misfiled as an admission failure | `monitorEventLoopDelay` gauge + probe co-measurement (§8) |
| Mixed-version pair (F4 class): one machine admission-live, peer on the old blanket | Safe by construction — admission is machine-LOCAL, no wire protocol; the old peer keeps throwing its raw string errors. NAMED here per the F4 lesson (any dev-gated mesh feature halves on a mixed pair): the §6 surface reports `mode` so the pair's asymmetry is visible, and graduation (§7) requires both dev machines flipped together | no cross-machine dependency in the design |
| Refusal storm (a caller loops on 409) | Bounded: refusals are cheap (no side effects) + per-source aggregate alerting only; the log row carries the caller route for diagnosis | §6 dedup |
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
- **Event-loop-lag gauge** (`perf_hooks.monitorEventLoopDelay`, ~zero cost)
  exported on `/health` and `/write-admission` — the P2-6 attribution
  instrument (§1.3/§1.4) and the standing measurement P1-A7 needs anyway.
- **Guard posture:** `writeAdmission` appears in `GET /guards` (dark-default
  classification; `on-dry-run` while soaking) — a load-shed disable is visible,
  never silent.
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

Ladder (mutation-bearing → full ladder):
1. **Dark fleet / live-dev in dryRun** (ships this way): admission EVALUATES
   everything and LOGS would-verdicts; the legacy blanket guard keeps
   enforcing; zero behavior change anywhere. Soak on the dev pair (Laptop +
   Mini) collecting §6 divergence rows.
2. **`dryRun:false` on the dev pair — BOTH machines in the same deploy window**
   (the F4 mixed-pair lesson): relaxations + typed refusals go live;
   graduation gate = ≥3 days with (a) zero `wouldRefuse`-was-wrong rows
   (legitimate write refused), (b) zero admitted-write fork incidents (WS2.x
   conflict surfaces stay clean), (c) the §8 live-proof green.
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
preserves the legacy message string for log-scraping continuity.

## 8. Tests (tiers declared) + live-proof clause

- **Tier 1 (unit):** WriteAdmission verdict table (every domain × role ×
  ownership state × pool-active × dryRun — both sides of every boundary);
  fail-closed on `placing`/contested; single-machine admit-all; StateManager
  guardWrite delegation incl. legacy fallback on admission throw; kv prefix
  classification (`build-context` → session-scoped); refusal body schema;
  I2 timing (p99 <1ms over 10k calls); registry↔wiring identity (the map the
  tests read IS the map the server wires).
- **Tier 2 (integration):** `POST /evolution/actions` + `POST /attention` on a
  simulated standby-that-owns-topics → 201 (admitted, machine-local) with the
  gate still applied after admission; a `cluster-shared` route on a non-holder
  → 409 typed body, <2s, zero store mutation (I3 asserted by store snapshot);
  dryRun mode → legacy behavior + would-verdict rows; admission-throw →
  legacy behavior (fail direction).
- **Tier 3 (e2e lifecycle):** production init path constructs the registry,
  index, and routes; `GET /write-admission` answers 200 live-on-dev / 503 dark;
  guard posture row present. Burst-invariant: a refusal storm creates ≤1
  attention item.
- **Live-proof clause (the roadmap 4.3 acceptance):** on BOTH machines (Mini =
  lease holder, Laptop = pool-owning non-holder), a probe battery of
  `POST /evolution/actions` + `POST /attention` (plus one deliberately
  inadmissible cluster-shared write) — every probe **succeeds or
  typed-refuses in <2s**, measured p100 over ≥20 probes spread across ≥1h,
  with the event-loop-lag gauge co-recorded so any probe landing in a
  starvation window is attributed (visible gauge spike) rather than silently
  failed or waved through. A starvation-window failure does NOT pass the
  clause — it routes the residual to P1-A7 with data, and the clause re-runs
  after that fix.
- **Acceptance follow-through (Close the Loop):** immediately after the
  live-proof goes green on the dev pair, register the mm-audit P0/P1 findings
  ledger into the evolution queue via `POST /evolution/actions` on the Laptop
  (the machine that failed twice), resolve attention item
  `agent:mm-audit-registration-debt-2026-07`, and update fb-99ab6347 with the
  §1.4 revision + evidence.

## 9. Frontloaded decisions

1. **409 (not 503/423) for admission refusals** — state-based conflict; 503
   stays feature-dark; aligns with pool-transfer's 409 family.
2. **Refuse, don't proxy (wave 1)** — forwarding a write is authority-bearing
   and duplicates WS4.1-style machinery; the refusal names the owner so the
   caller (or a later Phase-2 forwarder) re-targets deliberately.
3. **Evolution + attention are `machine-local`** — both stores are per-machine
   single-writer with existing convergence (WS2.5 replication; pool-scope merge
   + WS4.1). Admitting them everywhere IS the P2-6 fix, not a fork risk.
4. **The lease boolean survives as the cluster-shared gate** — no coordinator
   rewiring; smallest possible authority change; U4.2/U4.4 interplay untouched.
5. **Registry defaults fail toward today** (I8) — unclassified = current
   behavior + lint visibility, so partial adoption can't silently drop a guard.
6. **DryRun keeps the LEGACY guard enforcing** — the new layer gets zero
   authority until an explicit `dryRun:false`; the write-safety canary pattern
   from credential-repointing.
7. **Event-loop instrumentation is IN scope; event-loop repair is OUT** — the
   typed-refusal guarantee is honest only if hang windows are measurable; the
   repair is P1-A7's own root-cause track.
8. **Both dev machines flip `dryRun:false` in one window** — the F4 mixed-pair
   lesson applied prospectively.

## 10. Open questions for the convergence ceremony

- **OQ1 — Ownership index source of truth:** the spec assumes the session
  pool's custody layer can maintain a synchronous in-memory index updated on
  CAS transitions. Reviewers should confirm the exact structure to hook
  (SessionRouter custody records vs placement store cache), and whether a
  staleness bound on the index is needed beyond CAS-event-driven updates —
  especially across the F1 `placing`-wedge class, where custody records sit in
  `placing` for long periods (does I5's fail-closed then refuse legitimate
  owner writes on those five known-stuck topics until F1's upstream fix lands?).
- **OQ2 — Wave-2 topic-scoped inventory:** which routes/stores are
  topic-scoped in truth (topic profiles, resume UUIDs, autonomous state files,
  MCP session config)? Needs a grounding pass over the registry candidates —
  misclassifying a genuinely-shared store as topic-scoped is the one place this
  design could WEAKEN fork-safety (I4 guards the reverse direction).
- **OQ3 — Phase-2 forward-on-refusal:** should an idempotent, owner-refused
  write be forwardable over the existing authenticated mesh channel (WS4.1
  remote-ack pattern) instead of bouncing to the caller? If yes, which writes
  are idempotent enough, and does the forward carry the caller's authority or
  the machine's (KYP)?
- **OQ4 — kv key classification granularity:** prefix-matching on kv keys is
  coarse (`build-context` is clean; others may interleave shared + scoped data
  under one key). Is a per-key allowlist enough, or does any store need
  splitting before classification?
- **OQ5 — refusal status for `ownership-unresolved`:** 409 with
  `retryable:true` vs 503+Retry-After. 409 chosen for uniformity; reviewers
  may prefer 503 for the transient case so generic HTTP clients back off
  correctly.
- **OQ6 — does the tone gate belong AFTER admission for `POST /attention` in
  dryRun too?** Reordering in dryRun is behavior-neutral for outcomes but
  changes latency/token spend on the refusal path only when live; simplest is
  to reorder only at `dryRun:false`. Confirm no caller depends on gate-before-
  validation side effects (the decision log rows would thin out for refused
  sends).
