---
title: "Ownership-Gated Spawn, Duplicate Reconciliation & Judgment-Within-Floors"
slug: "ownership-gated-spawn-and-judgment-within-floors"
author: "echo"
parent-principle: "Signal vs. Authority"
lessons-engaged: "P2 (Structure > Willpower), P3 (Migration Parity), P4 (wiring integrity), P7 (LLM-Supervised Execution), P14 (Distrust Temporary Success), P17 (Bounded Notification Surface), P19 (No Unbounded Loops), L7 (affirmative evidence), mirror-decision-methods-share-gates (PR #1125), cross-machine-transfer-not-wired (2026-06-15), G3 (A Dark Feature Guards Nothing)"
---

# Ownership-Gated Spawn, Duplicate Reconciliation & Judgment-Within-Floors

**Status:** DRAFT — round-2 (round-1 findings folded).
**Operator directive:** Justin, topic 11960, 2026-07-10 ("yes please!", 19:40 PDT) — ship the duplicate-session fix as the first live instance of the judgment-within-floors pattern, and ratify the supporting standards in the same cycle.
**Ancestor incidents:** 2026-07-10 duplicate cross-machine sessions (topics 29723 + 29836, root-caused with logs — §1); 2026-07-05 recurrence (Mini duplicate of `echo-llm-pathway-characterization` remote-closed); 2026-06-25 topic-28730 ownership-split stall (forwarding-side sibling).
**Grounding:** all `file:line` anchors verified against upstream/main @ 7406c8e61 (2026-07-10) by three independent code-recon passes + six round-1 reviewer verification passes.

---

## 0. Constitutional Traceability (required by the Constitutional Traceability standard)

| This spec | Standard |
|---|---|
| Binding router verdict at spawn callsites | **Signal vs. Authority** (the incident is the canonical violation: verdict computed at `src/commands/server.ts:2484`, discarded by the `acked`-keyed short-circuit at `:2537`). Floors here are the S-v-A **exemption class** — enumerable-domain invariants and safety gates on irreversible actions, where deterministic blocking is sanctioned. |
| One enforced decision seam for session creation | **Structure > Willpower** |
| Owner-dark ladder always answers or honestly notifies; resolution-error fails toward spawn, loudly and boundedly | **The Agent Is Always Reachable**; silent-loss-refusal-conservation §2.D |
| Reconciler converges duplicates automatically, confirm-ticks + veto breaker + evidence bar | **Close the Loop**; **Bounded Blast Radius**; P19 |
| Arbiter calls attributed, metered, benched, provenance-logged | **Observable Intelligence**; **Token-Audit Completeness**; **Intelligent Prompts** |
| Arbiter = mind informs within body's floors, every call audited | **The Body and the Mind** / `docs/signal-vs-authority.md` ("make it *inform* the mind instead, and audit the call") |
| **NEW standard: Judgment Within Floors** (§7 — *derives from* Signal vs. Authority + The Body and the Mind; sharpens, does not invert: see the article's Derives-from clause) | Gap (stated precisely): the registry tells a builder that invariants are structural and that the mind holds final authority above the floor — nothing tells a builder HOW to place the boundary at a competing-signals decision point, or what a delegation must carry (floor, default, ladder, provenance). |
| **NEW standard: Decision Provenance & Outcome Review** (§7 — *derives from* Observable Intelligence: extends per-call metadata auditability to decision CONTENT + outcome grading) | Gap: no requirement that LLM decisions log full handed context and get outcome-graded against ground truth. |
| **NEW standard: Ownership-Gated Side Effects** | Gap: nothing requires session-creating/reviving actors to prove conversation ownership at fire time (revival actors do it ad-hoc — §2.4; the interactive spawn path doesn't). |

Per Part B, approval of this spec ratifies the three standards; their registry text is §7. The approval surface (ELI16 overview) presents **each standard as its own checkbox line** so ratification is per-standard, not a bundle-blur; the registry text lands in the SAME PR as Increment 1's guard files (no dangling "Applied through" refs — conformance-audit rule).

## 1. Problem statement — the incident (evidence-grounded)

2026-07-10, times UTC. The Laptop — owner of topics 29723 (live apprenticeship autonomous run) and 29836 (postmortem, hard-pinned to Laptop) — crash-looped ~23:15–23:49 (bloated 50MB replicated journal × new boot-time scan × supervisor kill cadence; fixed separately). Inbound messages for both topics arrived at the Mac Mini (lease holder / front door):

1. The Mini's router produced the correct verdict: `[session-pool] route topic 29723 → action=queued owner=? self=m_4cbc… acked=false`, and for 29836 `[session-router] attention: No machine available for session — 29836: hard-pin-unsatisfiable`.
2. **6 ms later** the inbound handler's fall-through spawned locally anyway: `[telegram→session] Session "…" needs respawn` → `[SessionManager] Spawning interactive session…` → `[telegram] Registered topic 29723 <-> session…` (29836 at 23:19:51).
3. **7 s later** the Mini's one-voice gate logged `SpeakerElection topic 29723: speak=false (owner-other)` — one subsystem knew the topic belonged elsewhere seconds after another spawned for it.
4. The Laptop recovered 23:49:47 with its tmux-persistent sessions intact → live duplicates on both machines.
5. Nothing converged them: the duplicate detector is observe-only; the post-transfer closeout was structurally inert (§2.3); the Laptop's reaper skipped its copies (`skipped:not-lease-holder`), the Mini's skipped its own (`skipped:open-commitment`).
6. Manual heal 00:43:30Z (remote-close, audited in `logs/remote-close-audit.jsonl`).

Dormant same-class hazard found during the investigation: a frozen Mini resume-queue entry ("revive 29836 HERE", queued Jul 5 while the queue was paused) — cancelled by hand 2026-07-11. (§2.4 explains why the drain's own guards would *probably* have invalidated it, and why "probably" isn't good enough.)

**Root cause, one sentence:** the routing verdict is computed and then discarded — the inbound handler's short-circuit keys on durable-queue custody (`acked`) rather than on the ownership verdict, the durable queue that would set `acked` ships dark, and the router's own `handleLocally` is a no-op — so a non-owner front door falls through to the legacy local spawn, and no reconciler converges the resulting duplicate.

## 2. Current machinery (verified)

### 2.1 The routing verdict and where it leaks
- Engine: `SessionRouter.dispatchOne` (`src/core/SessionRouter.ts:271-304`). Actions: `handled-locally | forwarded | spawned | queued | duplicate | owner-dead-replaced | placement-blocked | rejected` (`:73-92`). Dark owner → `markOwnerSuspect` + `placeAndClaim('failover')` (`:292-294`); hard pin unavailable → `{outcome:'queued', escalationReason:'hard-pin-unsatisfiable'}` (`src/core/PlacementExecutor.ts:216-228`), never rerouted.
- The Telegram inbound handler consults it once (`src/commands/server.ts:2484`), then: `rejected` → notify (`:2503`); remotely-handled → return (`:2529`); `queued/placement-blocked && acked` → return (`:2537`); **everything else — including un-acked `queued` — falls through** (`:2542`) to injection/respawn (`:2613/:2631`) or cold spawn (`:2691`, behind the G3 lease gate `:2667` — a different mechanism, fenced awake-lease, not ownership).
- `acked` is true only when the durable inbound queue takes custody; the queue ships dark (`multiMachine.sessionPool.inboundQueue.enabled:false`, `src/config/ConfigDefaults.ts:1367-1369`), so `queueMessage` returns `'refused'` (`src/commands/server.ts:21180-21190`) and `acked` is structurally false on the fleet.
- The router's `handleLocally` dep is a no-op (`src/commands/server.ts:21175`) — the router never spawns; every caller's fall-through does. There is no single enforcement seam: Slack inbound (`:9048/:9358`) and the drain tail (`:2811/:2813` — which DOES re-route first) each branch independently.
- Error semantics today: `resolveOwnership` (`src/commands/server.ts:21112-21117`) has no error state; registry read failures THROW, and the handler's catch (`:2543-2556`) fails open to local dispatch. Callers cannot distinguish owner-dark vs unowned vs error — both of the first two surface as `queued, owner=?`.

### 2.2 The duplicate detector is observe-only
`pool.duplicateTopics` is computed inside `GET /sessions` scope=pool (`src/server/routes.ts:7468-7532`): same `${platform}:${platformId}` live on ≥2 machines (headless/jobs excluded). Nothing consumes it beyond the dashboard badge. **It is request-driven** — it runs only when a dashboard polls; there is no unattended tick (round-1 scalability finding: exactly the overnight-crash window has no dashboard watching).

### 2.3 Why the existing closeout could not heal this
The post-transfer closeout — immediate half at `src/commands/server.ts:21982-22006`, reaper-tick sweeper via `SessionReaper` (`src/monitoring/SessionReaper.ts:1009-1024`, terminate at `:893-958`, config `topicMovedCloseout:true`, `topicMovedConfirmTicks:2`, `topicMovedVetoBreakerAttempts:5` at `:153-155`, F8 lease carve-out `bypassLeaseForTopicMovedCloseout` at `:919-928`) — is gated on `topicOwnerElsewhere` = `reg.ownerOf(topicId) !== self` (`src/commands/server.ts:8972-8979`). A deliberate move WRITES that ownership record; an independently-spawned duplicate does not. On the Mini the registry had NO active record for these topics (hence `owner=?` in the route log), so `ownerOf` gave nothing to compare and the sweeper never fired. **The missing piece is not a new closer — it is a converged ownership record.** Note also the two-source-of-truth wrinkle: the Mini's PIN store knew the Laptop held 29836 (`hard-pin-unsatisfiable`) while its ownership registry held no record; §3.2 reconciles both.

### 2.4 Revival actors are already ownership-gated (verified — narrows this spec)
- `ResumeQueueDrainer.validateReality` (`src/monitoring/ResumeQueueDrainer.ts:594-643`) invalidates on `live-session-exists`, `topic-owner-elsewhere`, `resume-uuid-stale`, `binding-mismatch`, `operator-stop`, `autonomous-run-finished`, `commitment-no-longer-active`.
- `AutonomousLivenessReconciler` blocks on `topicOwnerElsewhere || !holdsLease` (`src/monitoring/AutonomousLivenessReconciler.ts:365-372`), already-live (`:379-393`), queue-owns (`:394-403`), and re-checks all of it at the actuation instant (`:622-644`).
So the unguarded creation paths are exactly: **the interactive inbound spawn/respawn fall-through (§2.1)** and any actor relying on an ownership record that was never written (§2.3). This spec closes those two; it does not rebuild what already works.

### 2.5 Reap immunity
The authority skip ladder (`SessionManager.terminateSession`, `src/core/SessionManager.ts:1311-1430`): protected → not-lease-holder (`:1344-1348`) → ReapGuard cascade (`src/core/ReapGuard.ts:131-224`: spawn-grace, recovery-in-flight, pending-injection, relay-lease, recent-user-message, open-commitment, active-subagent, structural-long-work, active-process; guard-error → KEEP) → in-flight. The Laptop's copies were shielded by `not-lease-holder`, the Mini's by `open-commitment`. Each guard is individually correct; jointly they make a duplicate immortal. **Round-1 correction (adversarial + lessons-aware, independently verified):** the F8 carve-out precedent lifts ONLY the lease gate — `attemptCloseoutTerminate` re-checks every other KEEP guard fresh (`SessionManager.ts:1284-1294`), and `open-commitment` is topic-scoped and re-armed by owner-side user traffic (`ReapGuard.ts:66-79,183-193`). A converged record alone therefore does NOT dissolve the Mini-side shield; §3.2.4a addresses it explicitly.

### 2.6 Substrate honesty (verified — round-1; the preconditions in §3.2.0 and §4 exist because of these)
- **The fleet-default ownership store is in-memory.** `InMemorySessionOwnershipStore` (records wiped on restart — regenerating §2.3's "no record" state); the durable `LocalSessionOwnershipStore` + cross-machine materialization activate only under the replication/dev gates (`src/commands/server.ts:18966-18979`), with pool-consistent activation added after the 2026-06-16 seat-died-on-arrival incident (`:18952-18963`).
- **Cross-machine convergence rides journal replication.** `OwnershipApplier` materializes peer records from the REPLICATED placement journal (`server.ts:18940-18990`) — the same channel class whose bloat triggered the ancestor incident. There is also a documented false-positive history for cross-machine ownership claims (memory: "cross-machine transfer not wired", 2026-06-15).
- **The one-voice election is owner-liveness-blind.** `SpeakerElection.decideInner` rule 1 returns `speak=false (owner-other)` from the ownership record with no liveness input (`src/monitoring/SpeakerElection.ts:122-127`) — the incident's own log line. A dark owner therefore holds the topic's voice while being unable to use it.
- **The hold rung's current shape lives inside the dark queue block.** `holdVerdict` is constructed only when the inbound queue is enabled (`server.ts:21255-21270`); on the fleet there is no hold machinery at all.
- **The claim rung's engine ships dry.** `StaleOwnerReleaseEngine.actForceClaim` (U4.2) is dev-gated dryRun — would-claims logged, no authority moves.
- **Pin-store writes are NOT ownership-registry CAS.** The pin store replicates via the U4.1 HLC fold with skew-quarantine + PIN-gated readmit — different conflict semantics from `SessionOwnershipRegistry.cas` (`src/core/SessionOwnershipRegistry.ts:182`).

## 3. Proposed design

Four deterministic layers (A–D) + two LLM judgment points (J1, J2) inside them. **Consistency model, stated once (round-1 codex):** ownership-record writes are single-writer-serialized — normal placement writes go through each machine's local CAS + journal replication; RECONCILIATION writes (repairs) are made only by the serving-lease holder, carry the lease epoch as a fencing token plus the record's monotonic `ownershipEpoch`, and a peer applies a repair only if the fencing epoch is current and the record epoch advances. Two machines cannot both be reconciler (fenced lease); two machines CAN both believe they own a topic (async replication) — that state is a first-class reconciler input (§3.2.1), resolved on epochs, never wall-clock recency.

### 3.1 Layer A — Binding verdict at the spawn seam (prevention)
**A new `SpawnAdmission` check, consulted at every session-creating callsite for a conversation-bound topic** (Telegram cold-spawn `:2691`, Telegram respawn `:2613/:2631`, Slack `:9048/:9358`; the drain tail and revival actors already gate). Mechanics:
1. `resolveOwnershipSafe(sessionKey)` — a non-throwing tri-state wrapper over the ownership registry returning `{kind: 'self' | 'other-alive' | 'other-dark' | 'unowned' | 'error'}` (closes the §2.1 ambiguity; `other-dark` derives from the existing `isMachineAlive` input; `error` catches registry read failures instead of leaking a throw into the handler's fail-open catch). **It reads the in-memory/cached registry view only — never a synchronous durable read on the inbound path** (the store interface is designed for a future durable substrate; the seam pins to the cached view with accepted staleness).
2. **One resolution per message (TOCTOU guard):** when the router already produced a verdict for this message id, the seam CONSUMES that verdict rather than re-resolving — the admission decision and the routing decision cannot disagree mid-dispatch.
3. Admission table (deterministic floor):
   - `self` → spawn (today's behavior).
   - `other-alive` → forward (existing owner-side inject; today's behavior when routing works).
   - `other-dark` → **never spawn locally.** Run the owner-dark ladder (§3.3).
   - `unowned` → route through `placeAndClaim` and spawn ONLY as the claimed owner (the router already does this; the seam makes its result binding).
   - `error` → spawn locally (reachability wins over a broken store), **bounded:** once per topic per error-episode, one journal row + ONE deduped attention item (dedupe key `spawn-admission-error:<machineId>:<episode>`, wording frontloaded in §FD), and an **error-arm breaker**: K consecutive `error` resolutions (default 5) trip the arm from spawn-locally to the rung-3 notice floor (§3.3) until a clean resolution closes the episode — a persistently broken registry cannot re-open unbounded duplicate spawning fleet-wide, because gate and healer share that fault domain (§3.2 freezes on registry error too).
4. The `queued`/`placement-blocked` verdicts suppress local spawn **independently of `acked`**: if the durable queue is dark, the fallback is the deterministic G1-style notice path (§3.3 rung 3), not the legacy spawn.
5. Single-machine installs / pool `dark`: the seam short-circuits to `spawn` — byte-identical behavior, zero regression.
Rollout flag: `multiMachine.sessionPool.ownershipGatedSpawn` (shape + semantics in §4).

### 3.2 Layer B — Duplicate reconciler = converge the ownership record (auto-heal)

#### 3.2.0 Substrate precondition (round-1: lessons-aware LA1-2, adversarial ADV1-8)
Layer B's enforcement flip is **gated on the durable + replicated ownership substrate being live on every pool machine** (`LocalSessionOwnershipStore` + journal materialization, pool-consistent activation — the existing `server.ts:18952-18963` signal pattern). On the fleet default (in-memory store, no replication) `other-alive`/`other-dark` are unresolvable cross-machine and convergence writes are meaningless; the reconciler refuses to arm there (a loud `substrate-not-ready` status, never silent). Both feature flags join the machine-coherence guard's coherence-critical set so a pool split (enforcing on A, dryRun on B) raises the guard's ONE deduped item.

#### 3.2.1 Trigger, cadence, and input freshness
1. Runs on the serving-lease holder as its own tick (default 60s) **riding the WS4.4(f) shared pool poll-cache** for candidate discovery — but a candidate row from cache/`stale:true` is never acted on: before any record write the reconciler makes a **fresh direct probe** to both machines confirming (a) the duplicate still exists and (b) the intended owner holds a LIVE copy (`target-has-live-copy` precondition). Stale-snapshot convergence — rewriting ownership against a session that already exited — is structurally impossible.
2. Per-tick caps: `maxReconcilesPerTick` (default 3) and `maxConvergenceWritesPerTick` (default 5) — mass-duplicate events (split-brain heal) are paced, never a write storm (precedent: `maxReapsPerPass`, `maxFailoverReleasesPerTick:5`).
3. The reconciler DEFERS a topic while it has: an in-flight transfer, an open stale-owner-release episode, or an active owner-dark hold (§3.3) — one authority in motion per topic at a time.
4. **Partition honesty (round-1 gemini):** the lease holder can only heal what it can observe. Duplicates wholly inside a partition it cannot reach persist until the partition heals — accepted; the mesh's existing partition alarms (rope-health `urgent`) cover the visibility gap. On partition heal, the next tick sees the merged view.

#### 3.2.2 Intended-owner determination (evidence-ordered; round-1 rewrite)
Deterministic rules, in order — each rule requires its evidence class, and **peer-poll self-reports are never sufficient on their own** (round-1 security SEC1-3):
1. **Hard pin** (pin store; a quarantined pin never counts).
2. **Highest `ownershipEpoch`** in any machine's replicated registry view — the CAS-native monotonic epoch, NEVER wall-clock recency (clock skew already corrupted pin records once; that is why pin-quarantine exists). Symmetric divergence — both registries claim `self` — is a first-class input resolved here: higher epoch wins; equal epochs → rule 3.
3. **Server-registered live autonomous run** for the topic (the run registry — server-minted state, not a peer poll row; `POST /autonomous/register` snapshot).
4. Otherwise: **judgment point J2** (§3.4) with its mechanical-corroboration floor; J2 unavailable or evidence-free → **escalate ONE attention item** (never guess silently). "Most recent user interaction" is deliberately NOT a rule — the non-owner duplicate often has the latest message BECAUSE of the bug (round-1 codex); duplicate-side recency as the only differentiator is an escalate, not a signal.
**Both-copies-carry-live-runs** (liveness-reconciler/resume-queue races make this real): always `escalate-to-attention`, no auto-converge — the two "never close a run-carrier" and "owner survives" floors would contradict, and a reconciler-initiated transfer would meet the 409 `needsConfirmation` consent gate an autonomous actor must not answer. A reconciler action that receives 409 ESCALATES, never retries.

#### 3.2.3 Convergence mechanics
1. Repairs write through `SessionOwnershipRegistry.cas` (`src/core/SessionOwnershipRegistry.ts:182`) with the §3 fencing (lease epoch + record epoch). Pin-store coherence repairs go through the **pin store's own write path** (the U4.1 HLC fold; a repair colliding with pin skew-quarantine defers to the quarantine — readmit stays the operator's PIN-gated action). Write order is fixed: ownership record first, pin repair second; a crash between them is healed idempotently on the next tick (the reconciler re-detects the residual disagreement).
2. **Peer-echo confirmation (round-1 adversarial ADV1-2 — the healer must not silently depend on the channel whose failure caused the incident):** after a convergence write, the reconciler confirms within a bound (default 2 ticks) that the NON-owner machine's own registry view now names the converged owner — via the existing authenticated mesh read it already uses for probes. No echo → the topic escalates (`convergence-not-observed`, one deduped item); the closeout is never assumed armed on a peer that provably hasn't seen the record.
3. The existing post-transfer closeout sweeper then closes non-owner copies through its normal gated path (`topicMovedCloseout`, 2 confirm ticks, veto breaker, F8 lease carve-out) — reap-log reason extended to name `duplicate-reconciled`. **No new killer is introduced.**
4. A `duplicate-reconciled` close is **never resume-queue-eligible at enqueue time** (not merely invalidated at drain) — one subsystem must not mint garbage for another to collect, and a later J2 ownership move must not flip the drain-time answer.

#### 3.2.4 Survivor floor (deterministic)
Owner's copy survives by default; a non-owner copy that is mid-turn / carrying live subagents defers via the existing work-gate probe (`SessionRefresh.consultWorkGate`, `src/core/SessionRefresh.ts:413-426` / `SessionManager.probeWorkState`); a non-owner copy driving a LIVE autonomous run is never closed — ownership MOVES to it via the deliberate transfer path instead (except both-run → escalate, §3.2.2); protected sessions never auto-closed; last-unanswered-message re-injection via `resolveUnansweredInbound` (`SessionRefresh.ts:196-198`) on the surviving copy.

**3.2.4a The commitment-shield correction (round-1 material, adversarial + lessons-aware convergent — the §2.5 verified fact):** a converged record alone leaves the incident's Mini-side copy immortal (`open-commitment` KEEP re-checked fresh at terminate). Two-part fix, both required:
- **Commitment custody moves with ownership:** before the closeout closes a non-owner copy, its topic-scoped open commitments are re-bound to the surviving copy's session (a `CommitmentTracker.mutate` CAS re-bind — the commitment is a promise to the TOPIC's user; the survivor is now serving that topic). The re-bind is audited on the commitment record.
- **A narrow `duplicate-reconciled` carve-out for the `open-commitment` and `recent-user-message` KEEP guards** — single-disposition, mirroring the existing `bypassRecentUserMessageForConfirmedMove` precedent (`SessionManager.ts:1280-1294`), valid ONLY when the fresh probe confirms the owner copy is live and serving (the §3.2.1 `target-has-live-copy` precondition). Every other KEEP guard (active-subagent, structural-long-work, in-flight, protected) still vetoes — those shield real work, not topic bookkeeping. This engages the mirror-decision-methods-share-gates lesson (PR #1125) deliberately: the carve-out is shared by exactly the one disposition, defined next to the F8 precedent it mirrors.

#### 3.2.5 P19 breaker
A topic re-duplicating ≥3 times in 24h stops being auto-reconciled and raises ONE attention item. Counters are **per-topic episode counts in the replicated store** (not lease-holder-local — a lease flap must not reset a chronic topic's count; round-1 adversarial ADV1-17), TTL-pruned when idle >24h. Record FLIPS (convergence writes that reverse a prior convergence without re-duplication) count toward the same breaker (round-1 security SEC1-7). **Breaker-open also clamps the owner-dark ladder for that topic to rung 3** (queue/notice — no claim-then-spawn), so the duplicate GENERATOR is braked together with the healer (round-1 adversarial ADV1-7: a flapping owner must not keep minting fresh duplicates while reconciliation is frozen).

#### 3.2.6 Layer D fallout (corrected)
Because the reconciler converges the RECORD and §3.2.4a moves commitment custody + narrowly carves the two topic-bookkeeping KEEP guards, the `not-lease-holder` and `open-commitment` shields stop making duplicates immortal — through the closeout's own gated path, not a new reap authority. A duplicate additionally shielded by REAL work guards (active-subagent, structural-long-work) ends at the closeout breaker's attention item — that is the honest design intent, stated: work-guarded duplicates escalate to the operator rather than being auto-killed.

#### 3.2.7 Supervision tier (P7)
The reconciler is **tier 0 declared-with-justification**: every non-mechanical choice routes to J2 or to the attention queue; the mechanical remainder (epoch comparison, CAS write, echo check) is deterministic with structural brakes. The graded-review job (§3.5) is tier 1.

### 3.3 The owner-dark ladder (Layer A's `other-dark` arm)

**Rollout-stage behavior matrix (round-1 integration INT1-1 — the ladder must be honest about what exists at each stage):**

| Stage | Rung 1 (hold) | Rung 2 (claim) | Rung 3 |
|---|---|---|---|
| Fleet today (queue dark, stale-owner-release dry) | none (no hold machinery) | none (would-claim logged only) | **the whole ladder**: deterministic notice, resend-wording (below) |
| Dev pool (queue live, release dry) | 90s hold (`holdMaxMs`) | logged would-claim only | durable-queue custody + honest notice |
| Dev pool (queue live, release live) | 90s hold | real fenced claim via the single CAS funnel | durable-queue custody + honest notice |

1. **Hold** — the existing hold-for-stability shape (`holdVerdict`, `src/commands/server.ts:21258-21268`; `holdMaxMs:90000`, `src/core/inboundQueueConfig.ts:77-79`). A blip never moves a conversation. Holds are capped: `maxConcurrentHolds` (default 20 per machine); over-cap → rung 3 immediately. Hold state is in-memory in-flight delivery state; a crash mid-hold loses at most the held message(s), bounded by the cap — and the rung-3 notice's resend wording is the honest floor for exactly that loss window. Queue-live removes the window (durable custody).
2. **Claim-then-spawn** — if the owner is provably dead per the stale-owner-release evidence bar, the claim goes through the existing single CAS funnel (`StaleOwnerReleaseEngine.actForceClaim` → `reconciler.actStaleOwnerForceClaim`, `src/commands/server.ts:19339`); the new owner then spawns as `self`. One-owner stays invariant; the user is answered by the surviving machine. **Dependency posture declared (G3 — a dark feature guards nothing):** this rung is inert while stale-owner-release is dryRun; the engine gains `loadBearing:true` + `criticalPath:'owner-dark-ladder'` on `/guards` when `ownershipGatedSpawn` enforces, and Layer A's enforcement on a pool is sequenced NO EARLIER than stale-owner-release leaving dryRun on that pool (§4). Until then rung 2 is a logged would-claim and the ladder's honest behavior is rung 3.
3. **Queue + honest notice** — death unprovable (wobbly-but-alive): durable-queue when the inbound queue is live; when it is dark, the deterministic floor is **notice-only, with state-accurate wording** — no "your message is queued" claim when nothing durably holds it (round-1 decision-completeness DC1-3). Frontloaded wording, cause-generic (§FD): dark-queue *"That conversation's machine is temporarily unreachable (it may be restarting). I can't safely answer from here, and I'm not holding your message — please resend in a few minutes, or send it to my Lifeline topic if it's urgent."*; queue-live *"…your message is saved and will be answered automatically when it returns."* Delivered on the **deterministic G1 path** (`telegram.sendToTopic` — the cold-start-lifeline precedent), **bypassing speaker election with a declared owner-dark exception**: election rule 1 is owner-liveness-blind (§2.6) and would structurally silence the notice (round-1 integration INT1-2). Dedupe: ONE notice per (topic, outage-episode) with a per-topic cooldown (default 30 min) — a flapping owner or an N-message burst yields one notice, not N (P17; the relay's length-gated dedup does not cover short notices). If the owner recovers mid-flight, the episode closes and no further notice sends.

**Silence ceiling (frontloaded value):** `ownerDarkLadder.maxUserSilenceMs` default **600000 (10 min)** — measured from first held/refused message of the episode to either a real answer or the rung-3 notice; J1 may shorten but never extend past it. (The incident's 34-minute window is the calibration: 90s hold + early notice beats 34 silent minutes.)

**J1 invocation discipline (round-1 scalability SC1-2):** J1 runs per **(owner-machine, outage-episode)** — ONE arbiter call when the episode opens, cached verdict applied to every topic/message in that episode, re-invoked only on state change (evidence bar newly passed, episode crossing the ceiling), TTL'd at the ceiling. Timeout budget 5s (`swapAttemptTimeoutMs` precedent); timeout/shed → deterministic default (fixed hold → notice at ceiling). Arbiter calls ride `buildIntelligenceProvider` as **non-gating** traffic (shed under contention, never held).

### 3.4 The judgment points (first live instances of Judgment Within Floors)
Shared contract (this IS the new standard, applied):
- **Bounded action space** — the model picks among options the floor proved safe; invalid/omitted/timeout → deterministic default. The floor can only be narrowed, never widened.
- **Bench-laddered fallback** — the arbiter model resolves via the routing registry's per-task record `{default, fallbacks[], floor}`; below-floor or all-doors-down → the deterministic default. The last rung is always static (the incident-correlated failure mode is all doorways degraded at once — the 2026-07-10 outage would have degraded the judge with the judged).
- **Never on the happy path** — invoked only on the ambiguous branch (`other-dark`; contested survivor). Zero added latency otherwise.
- **Untrusted-data envelopes on ALL free text, both arbiters** — message-derived urgency, journal prose, and session tails are delimited untrusted data (the cartographer-navigator contract); the provenance row records the enveloped form. This bounds instruction-following, NOT evidence-weighting — which is why the floors below require mechanical corroboration wherever a poisoned tail could steer a floor-legal wrong outcome (round-1 security SEC1-2, adversarial ADV1-5).
- **Provenance-logged** (§3.5), attributed, metered, benched.

**J1 — owner-dark rung arbiter** (`attribution.component: 'OwnerDarkArbiter'`). Context: crash-loop signature (supervisor kill cadence, boot progress from the replicated journal), heartbeat/git-sync recency, rope health, that machine's outage history, queue depth, message urgency (enveloped). Action space: `{keep-holding≤ceiling, queue+notify-now, proceed-to-claim-evaluation}`. J1 proposes; the claim itself still passes the mechanical evidence bar — J1 can NEVER authorize a claim.

**J2 — survivor arbiter** (`attribution.component: 'DuplicateSurvivorArbiter'`). Context: both copies' recent tmux tails (fetched via the live-tail chokepoint, **redacted on the SERVING machine before the wire**, byte-capped at the chokepoint's existing bound, quoted as untrusted data), autonomous-run state location, open commitments, session ages, last user interaction. Action space: `{owner-copy-survives, move-ownership-to-working-copy, defer-one-tick, escalate-to-attention}`. Floors:
- `move-ownership-to-working-copy` is a PROPOSAL, valid only when **mechanical work evidence corroborates it** — a server-registered autonomous run, a CommitmentTracker record, or the work-gate probe on that copy; tail text alone can never select it (mirror of J1's claim bar — the tail-poisoning counter).
- `defer-one-tick` is capped at 3 consecutive; the 4th tick forces the deterministic default (a runaway arbiter cannot make a duplicate immortal through floor-legal deferrals).
- All §3.2.4 floor guards apply regardless of choice.

**Registry obligations (mechanical, each CI-ratcheted; assignments frontloaded per round-1 DC1-4):** each arbiter joins `COMPONENT_CATEGORY` (`src/core/componentCategories.ts:36`) as category **`sentinel`**, task nature **B** in `natureRoutingMap.ts`, `LLM_UNTRUSTED_INPUT: true` with **injection-exposed** classification (both consume attacker-influenceable text; gates injection-unsafe doors per FD5b), `LLM_BENCH_COVERAGE` (`src/data/llmBenchCoverage.ts:32`) with parity-checked batteries `research/llm-pathway-bench/instar-bench-v2/tasks/{owner-dark-arbiter,duplicate-survivor}.json` (`source` anchor + `promptFidelity: verbatim`, cases across the five stress axes, seeded from the 2026-07-10 and 2026-07-05 incidents as the first real cases), a row in `docs/LLM-ROUTING-REGISTRY.md` (freshness lint), and a **bench-ladder floor tier of `capable`** (below-floor → deterministic default). Precedent: `ExternalHogClassifier` ("kill-SAFETY carried entirely by the deterministic floor").

### 3.5 Decision provenance & outcome review (net-new capability)
Verified gap: no durable full-context log exists today — `ResponseReviewDecisionLog` deliberately caps at 200 scrubbed chars + `contextMeta` (`src/core/CoherenceGate.ts:1552-1580`). This layer adds one:
- **`JudgmentProvenanceLog`** (JSONL + rotation via SafeFsExecutor, per deciding machine): one row per arbiter call — full context snapshot as handed to the model (enveloped form), options presented, decision + stated reason, floor bounds in force, model/door, tokens, latency, fallback rung. **Storage + exposure (round-1 security SEC1-1):** rows live under `state/judgment-provenance/` with file mode 0600, the directory joins the file-viewer's **never-served denylist** (the same class as `.claude/hooks/` — full bodies are not reachable through the dashboard Files tab or `/api/files/download` regardless of `allowedPaths`), and the files are **backup/support-bundle EXCLUDED** (declared, like the aggregates precedent). **Redaction honesty, stated:** bodies pass the `scrubString` chokepoint (`src/core/CredentialAuditEmit.ts`) and tail slices pass `liveTailRedaction` — both are credential-shape scrubbers, NOT PII scrubbing; that is exactly why full bodies are machine-local, deny-listed, and short-retention. The `FailureDetail {redacted, full}` split (`src/monitoring/FailureLedger.ts:74`) governs the HTTP surface: the named route `GET /judgment-provenance` (Bearer) serves REDACTED rows only, redacts on the serving machine before the wire, supports `?scope=pool` with type/length-clamped peer rows rendered as untrusted data. **The redaction contract is an INVARIANT, not config** (round-1 decision-completeness DC1-1 — an under-redacted row is a durable disclosure); retention IS config (default 30 days).
- **Write discipline (round-1 scalability SC1-4):** async buffered appends only — never sync I/O on the inbound path; per-row byte clamp (tail slices already capped; total row clamp 64KB); `provenance.deterministicSampling` knob (default 1.0 during Increment-1 soak, tunable down) for deterministic-verdict rows — arbiter rows are always written.
- **Outcome annotation:** ground truth is appended when it arrives — owner-return timestamps (already journaled), reconciler results, resend/complaint signals; mechanical where possible, review-time otherwise.
- **Graded review:** a cadenced, budget-capped, tier-1-supervised job (ships OFF; **maturation path declared:** registered as a `DARK_GATE_EXCLUSIONS` cost-bearing entry — budget-capped LLM replay — with the dev-agent-enabled soak → fleet-criteria ladder, like `bench-refresh`) replays sampled rows with outcomes attached and grades correct / wrong-but-reasonable / wrong; verdicts per judgment point route to needs-stronger-model vs needs-better-prompt vs needs-better-context; graded real cases feed the battery. Review NEVER regrades floors — only choices within them. Output: ONE digest attention item, operator-review-gated exactly like bench routing diffs.

### 3.6 The structural question (enforcement hook)
Two insertion points, both existing gates:
- **spec-converge:** a new structurally-checked question beside Standards A/B (`skills/spec-converge/SKILL.md`): every spec's `## Decision points touched` section must classify each decision point as `invariant` (deterministic, justified) or `judgment-candidate` (floor + arbiter declared, or an argued exemption). The convergence-tag writer refuses to stamp with the classification missing — same pattern as the open-questions refusal. **Verbatim gate text and grandfathering are frontloaded (§FD)**; specs already past round 1 when the gate lands are exempt.
- **instar-dev side-effects review:** a new numbered question in `skills/instar-dev/templates/side-effects-artifact.md` (verbatim text in §FD): "Does this change add a static heuristic at a competing-signals decision point? If yes: why is it not a judgment point within a floor?" — enforced by the existing pre-commit/pre-push artifact gates.
- **failure pipeline:** `FailureRecord` gains `judgmentCandidate?: boolean`; the analyzer's tsc-total `RECOMMENDATION_BY_CATEGORY` forces the paired recommendation text when the enum widens.
- **Migration parity (round-1 material, integration + lessons-aware + conformance gate):** both files are agent-installed and never overwritten by `installBuiltinSkills`; the PR adds two idempotent `PostUpdateMigrator` migrations following the exact existing precedents — the spec-converge SKILL bundled-copy + fingerprint pattern (`src/core/PostUpdateMigrator.ts:1216-1241`) and the side-effects template patch pattern (`:1395-1420`). Deployed agents receive both edits on their next update; listed in §8 deliverables.
- **Agent awareness (P5):** `generateClaudeMd()` gains the reconciler + notice surfaces ("why did my duplicate session disappear?" → the reconciler; "why did I get a resend notice?" → owner-dark ladder), with the matching `migrateClaudeMd()` content-sniffed section — the current template documents "flag not heal", which this spec reverses.

### 3.7 Alternatives considered (round-1 external reviewers, both families)
- **etcd/ZooKeeper-class lock manager or Kafka-class queue for ownership:** rejected — instar's design decision #1 is file-based state with zero external infra dependencies (an agent must bootstrap on a laptop with npm alone); the mesh already carries a fenced serving lease (the coordination primitive a DLM would provide) and a replicated journal (the log a queue would provide). The gap the incident exposed was not a missing primitive but an UNENFORCED verdict — adding an external system would not have made the verdict binding.
- **Deterministic tie-breaker instead of J2 (lowest machine id / earliest session):** the deterministic ladder IS complete without J2 — rule 4's static fallback is escalate-to-attention, and Increment 2 runs exactly that way. J2 exists because the incident-class residue is precisely where static rules were the proven failure (`open-commitment` immortality — two individually-correct rules jointly wrong); an arbitrary tie-break (machine id) picks a winner with zero evidence, which for a user-facing conversation is worse than either asking the operator or weighing real work evidence. J2's authority is bounded to proposals over mechanically-corroborated evidence — the cheap-tie-break's predictability is preserved in the default, the arbiter only upgrades decisions where evidence exists.
- **Pure workflow/state-machine policy for owner-dark timing (no J1):** viable — and it is the deterministic default the floor ships with. J1 is an optimization within it (a crash-loop signature read from the journal genuinely predicts recovery-in-minutes vs dead), justified by the bench flywheel: real outage episodes become graded battery cases, measurably improving the choice. If the graded review shows J1 ≤ static default, J1 is removed — that is the standard's own outcome-review teeth.

### 3.8 Self-heal declarations (Standard B — one block per escalating watcher)
| Watcher | remediation-actions | max-attempts | max-wall-clock | backoff | dedupe-key | breaker | max-notification-latency | audit-location | class |
|---|---|---|---|---|---|---|---|---|---|
| Duplicate reconciler (per topic) | converge record via CAS; re-bind commitments; peer-echo verify; then closeout closes | 3 convergence attempts/episode | 24h/episode | tick-paced (60s) | `dup-reconcile:<topic>:<episode>` | ≥3 re-dups or flips/24h → item + ladder clamp (§3.2.5) | **30 min** (episode open → item if unresolved) | `logs/duplicate-reconciler.jsonl` (scrubbed, metadata-only) | recoverable |
| Owner-dark ladder (per episode) | hold; fenced claim when evidence bar passes; queue/notice | 1 claim attempt/episode | silence ceiling (10 min) | n/a (laddered) | `owner-dark:<machine>:<episode>` | error-arm breaker (§3.1.3e) | **10 min** = the silence ceiling (user notice IS the escalation) | `logs/owner-dark-ladder.jsonl` | recoverable |
| SpawnAdmission error arm | fail-open spawn (reachability wins); breaker to notice floor | K=5 consecutive errors → breaker | episode-scoped | n/a | `spawn-admission-error:<machine>:<episode>` | K-consecutive breaker (§3.1.3e) | **5 min** (first error → item batched within) | journal + `logs/owner-dark-ladder.jsonl` | recoverable (registry corruption affecting user reachability is still recoverable — spawn proceeds; a SECURITY-class event, e.g. suspected record forgery, escalates same-tick) |

All three: escalation is structurally downstream of the heal attempt (the reconciler's item fires only after failed/echoless convergence or the breaker; the ladder notifies at the ceiling while still healing — notify-and-heal; the error arm's item rides the breaker). Flapping auto-reclassification: a topic breaker-tripping twice in 7 days escalates its item to HIGH. No no-op heals: each remediation is a named side-effecting operation with CAS/idempotency guards (§3.2.3).

## 4. Rollout (graduated; substrate-sequenced per round 1)

0. **Preconditions for any enforcement:** durable + replicated ownership substrate live pool-wide (§3.2.0), pool-consistent activation signal (the `server.ts:18952-18963` pattern), both flags in the machine-coherence coherence-critical set.
1. **Increment 1:** `resolveOwnershipSafe` + SpawnAdmission seam + reconciler, ALL dryRun (would-verdicts logged; legacy behavior unchanged). Provenance log ships with the seam (it logs deterministic verdicts too — the soak data IS the future battery seed). §3.6 gate questions + §7 registry text + both PostUpdateMigrator migrations land HERE (process + text, not runtime). The §3.8 declarations land as code constants next to the features.
2. **Increment 2:** flip A+B enforcing on the dev pool — which REQUIRES on that pool: inbound queue live (rung-3 custody) and stale-owner-release live (rung 2); deterministic defaults only (J1/J2 branches take static defaults). This pool recurs the bug — the perfect soak. Fleet stays dryRun; on the fleet the ladder's honest shape is the stage-matrix row 1 (notice-only).
3. **Increment 3:** J1/J2 arbiters in shadow (decide-and-log, not act); batteries land; parity-check covers them.
4. **Increment 4:** arbiters act within floors; graded-review job available (OFF, registered dark-gate exclusion). Fleet flip per increment only after quiet soak; every flag independently reversible.

**Config keys (all named; shape `{enabled:boolean, dryRun:boolean}` unless noted; boot-read, restart to apply; each registered in `DEV_GATED_FEATURES` per lint-dev-agent-dark-gate):**
- `multiMachine.sessionPool.ownershipGatedSpawn` — the seam.
- `multiMachine.sessionPool.duplicateReconciler` — Layer B (+ `maxReconcilesPerTick`, `maxConvergenceWritesPerTick`, `breakerThreshold`, `breakerWindowMs`).
- `multiMachine.sessionPool.judgmentArbiters` — J1+J2 (+ `shadowMode:boolean` for Increment 3).
- `ownerDarkLadder.maxUserSilenceMs` (default 600000), `ownerDarkLadder.maxConcurrentHolds` (default 20), `ownerDarkLadder.noticeCooldownMs` (default 1800000).
- `provenance.retentionDays` (default 30), `provenance.deterministicSampling` (default 1.0). Redaction: NOT config (invariant).
- Graded-review job: `judgment-outcome-review` manifest, ships `enabled:false`, DARK_GATE_EXCLUSIONS entry.

## 5. Test plan (Testing Integrity — all three tiers + wiring)

- **Unit:** tri-state resolver (each kind incl. thrown-registry → `error`, error-episode counting, breaker trip/close); admission table exhaustive incl. router-verdict consumption (TOCTOU); ladder rung transitions + stage matrix (queue dark/live × release dry/live) + silence ceiling + notice dedupe per episode; intended-owner rules (epoch beats recency; both-self; both-run → escalate; quarantined pin ignored; 409 → escalate); arbiter clamps (invalid/omitted/timeout/below-floor → default, action-space violation rejected, defer cap forces default at 4, move-without-corroboration rejected); provenance writer (schema, scrub, {redacted,full} split, byte clamps, async buffering, sampling); breaker (replicated counters survive lease move, flip counting, ladder clamp on open).
- **Wiring-integrity (P4 — the incident's root cause WAS a no-op injected dep):** assert SpawnAdmission is consulted at each named callsite (Telegram cold/respawn, Slack ×2) with non-null, non-no-op deps that delegate to the real registry/ladder; assert the provenance writer is actually wired at the seam (a verdict produces a row); assert the reconciler's closeout trigger reaches the REAL sweeper config, not a stub.
- **Integration:** inbound → owner-dark → notice path over real HTTP (queue dark AND live; wording matches stage); duplicate formed → record converged → peer-echo observed → closeout closes non-owner copy; commitment re-bind + carve-out (an open-commitment duplicate closes ONLY with live-owner probe confirmed; active-subagent still vetoes); work-gate deferral; arbiters stubbed to EVERY option proving floors hold under each; single-machine byte-identical short-circuit; registry-error freeze (reconciler + closeout refuse under registry error while spawn fail-open proceeds bounded).
- **E2E:** feature-alive (routes 200 not 503 where surfaced — `GET /pool/duplicate-reconciler`, `GET /judgment-provenance`); **the burst invariant:** a non-owner machine receiving N inbound messages for owned-elsewhere topics creates ZERO local sessions and EXACTLY ONE notice per topic-episode plus the queued artifacts (mirrors the notification-flood burst test, asserts the notice COUNT bound explicitly); duplicate-reconciliation lifecycle on a **real two-node harness in which the replication hop is NOT stubbed** — affirmative evidence that a lease-holder convergence write lands in the PEER machine's own registry view and arms the peer-side sweeper (L7; the closeout gate reads the peer's own `ownerOf`). The two-node harness is the Increment-2 entry gate.
- **Ratchets joined:** llm-attribution, bench-coverage, routing-registry freshness, no-unbounded-llm-spawn (arbiters ride `buildIntelligenceProvider`), lint-dev-agent-dark-gate (all three flags), lint-self-heal-fields (§3.8 blocks).

## Multi-machine posture (Standard A)

This spec is multi-machine BY SUBJECT — every surface below declares its posture explicitly.

| Surface | Posture | Mechanism / defense |
|---|---|---|
| SpawnAdmission verdicts | unified (derived, not stored) | computed per-call from the replicated ownership registry + pin store cached views; no new durable state |
| Ownership records the reconciler writes | unified | the EXISTING `SessionOwnershipRegistry` CAS + journal replication — **precondition-gated: Layer B arms only on the durable+replicated substrate (§3.2.0); fleet-default in-memory store → reconciler refuses loudly** |
| Pin-store coherence repairs (§3.2.3) | unified | the pin store's own U4.1 HLC-fold write path; defers to skew-quarantine (readmit stays PIN-gated) |
| `JudgmentProvenanceLog` full bodies | machine-local write, proxied-on-read | full rows written by the deciding machine only, under `state/judgment-provenance/` (0600, file-viewer deny-listed, backup-excluded); `GET /judgment-provenance` serves REDACTED rows (redact-on-serving-machine), `?scope=pool` merge with clamped untrusted-enveloped peer rows. The unified READ is the redacted view — a redaction boundary, not a locality assumption. |
| Reconciler P19 breaker counters | unified | per-topic episode counts in the REPLICATED store (survive lease moves — a chronic topic cannot evade the breaker via lease flap); TTL-pruned idle >24h |
| Owner-dark ladder hold state | machine-local BY DESIGN — `physical-credential-locality` | machine-local-justification: physical-credential-locality — the hold is in-flight delivery state of THIS machine's adapter socket (its Telegram long-poll / Slack socket connection — the delivery attempt physically exists only there; the bot token syncs, the live socket does not). Crash-mid-hold loss bound stated in §3.3.1: at most the held messages (≤ cap), floored by the resend-wording notice; durable-queue custody removes the window when live. |
| Arbiter bench batteries / routing registry rows | unified | git-tracked files, ride the repo |
| Self-heal audit logs (§3.8) | machine-local write, proxied-on-read | same shape as other `logs/*.jsonl`: metadata-only, scrubbed; read via existing log surfaces |

User-facing notices (owner-dark rung 3) ride the deterministic G1 path with a **declared owner-dark exception to speaker election** (§3.3.3) — the notice is deduped per (topic, episode) so the exception cannot produce competing voices.

## Frontloaded Decisions

1. **Part-B ratification path** — operator directed (topic 11960, 2026-07-10 19:40 PDT) that the three standards ship in this cycle; approval of this spec ratifies them. Their exact registry text is §7; the approval surface lists each standard as its own checkbox line; the text lands in the same PR as Increment 1.
2. **No new killer** (§3.2): the reconciler converges the ownership RECORD; the existing gated closeout does every close — WITH the §3.2.4a commitment-custody re-bind + narrow two-guard carve-out (round-1 correction; the bare form was proven insufficient against the incident).
3. **J1 proposes, never authorizes** (§3.3–3.4); **J2's ownership-move requires mechanical corroboration** (§3.4) — both non-negotiable floors.
4. **Deterministic defaults are complete** (§3.4): every judgment point functions with the arbiter absent (static rung). Increment 2 runs this way on purpose.
5. **Rollout is dryRun-first per flag with substrate preconditions** (§4): three named flags, independently reversible; Layer-A/B enforcement sequenced behind inbound-queue + stale-owner-release liveness on the same pool; pool-consistent activation. Cheap-to-change-after: every behavior change ships behind a named dark/dry-run stage.
6. **Provenance: redaction contract is an INVARIANT (scrubString + liveTailRedaction chokepoints + {redacted,full} split — non-configurable); retention/sampling are config** (§3.5, corrected per round-1 contest). Storage: `state/judgment-provenance/`, 0600, file-viewer deny-listed, backup-excluded, 30-day default retention. Honesty: scrubbers are credential-shape, not PII — hence the locality + denylist + short retention.
7. **Graded-review job ships OFF** with a declared maturation path: DARK_GATE_EXCLUSIONS cost-bearing entry (budget-capped LLM replay), dev-agent soak → fleet criteria (§3.5).
8. **Silence ceiling: 10 min** (`ownerDarkLadder.maxUserSilenceMs: 600000`); holds capped at 20; notice cooldown 30 min/topic (§3.3).
9. **Notice wordings** (§3.3.3): the two state-accurate variants quoted there are the shipping text (cause-generic "temporarily unreachable (it may be restarting)").
10. **Arbiter registry assignments** (§3.4): category `sentinel`, nature B, `LLM_UNTRUSTED_INPUT:true` + injection-exposed (both), bench floor tier `capable`; J2 tail slice = the live-tail chokepoint's existing byte bound.
11. **Error-arm bounds** (§3.1.3e): once-per-topic-per-episode, K=5 breaker to notice floor, dedupe key `spawn-admission-error:<machineId>:<episode>`, attention wording: *"I couldn't read conversation-ownership records on <machine> (N consecutive failures), so new conversations there are answered locally and duplicates are possible until this clears. Details: <journal ref>."*
12. **§3.6 gate texts + grandfathering:** side-effects question verbatim (§3.6); spec-converge question verbatim: *"Does `## Decision points touched` classify every decision point as `invariant` (with justification) or `judgment-candidate` (floor + arbiter declared, or an argued exemption)? Refuse the tag if the section or a classification is missing."* Specs past round 1 at gate-land are exempt.
13. **Both-run duplicates and reconciler-409s always escalate** — never auto-converge, never retry (§3.2.2).

## Decision points touched (per §3.6, eating our own cooking)

| Decision | Classification | Why |
|---|---|---|
| May this machine spawn for this topic? | **invariant** | one-owner-per-conversation; delegated judgment here IS the incident |
| Owner-dark: how long to hold / when to notify / when to evaluate claim | **judgment-candidate → J1** | competing signals, prediction from messy evidence; floor: ladder + ceiling |
| Is the owner provably dead (claim authorization)? | **invariant** | evidence bar stays mechanical; J1 proposes only |
| Which duplicate survives? | **judgment-candidate → J2** | contested work evidence; static rules are the proven failure (`open-commitment` immortality); floor: §3.2.4 + mechanical corroboration for moves |
| Both copies carry live runs | **invariant** | escalate-to-attention; contradictory floors otherwise (§3.2.2) |
| Close a copy mid-turn? | **invariant** | never — work-gate floor |
| Provenance body redaction | **invariant** | scrub chokepoints, never judgment, never config |
| Commitment custody on reconciled close | **invariant** | mechanical re-bind to survivor before close (§3.2.4a) |

## 7. Standards registry text (three `###` articles; enforcement guards named per the auditor's resolution rules)

**Family: Building — `### Judgment Within Floors`**
**Rule.** A decision point with competing signals or non-enumerable context may be delegated to an LLM arbiter only inside a deterministic floor: the floor defines the complete safe action space and a conservative default; invariants are never delegated; the arbiter can narrow but never widen; an arbiter choice with irreversible consequence requires mechanical corroboration, never free-text evidence alone; fallback follows the bench-ranked ladder and always ends at a deterministic rung. A new static heuristic at such a point must state why it is not a judgment point.
**Derives from.** *Signal vs. Authority* and *The Body and the Mind* — and sharpens rather than inverts them: floors are the documented exemption class (enumerable-domain invariants and safety gates on irreversible actions) where deterministic blocking is sanctioned; ABOVE the floor the mind holds the choice, exactly as The Body and the Mind requires. Coexists with *Tiered Development*'s audited below-floor authority: a JWF floor is a per-decision-point action-space bound, not a tier gate; Tiered Development governs who may change the floor, JWF governs what runs inside it.
**In practice.** Applied through `src/core/SpawnAdmission.ts` (J1 floor) and the duplicate reconciler survivor floor; contested per-spec via the spec-converge decision-point classification and per-change via the side-effects question; arbiters join the four routing registries and carry parity-checked batteries.
**Earned from.** 2026-07-10 duplicate-session incident: the static reap heuristics (`open-commitment`, `not-lease-holder`) made duplicates immortal, while the missing enforcement of an already-computed verdict caused them.
**Traces to the goal.** The mind decides within the body's constraints; neither substitutes for the other.

**Family: Building — `### Decision Provenance & Outcome Review`**
**Rule.** Every LLM judgment call durably logs the full context it was handed and the decision it made — scrubbed, retention-bounded, machine-local-full/HTTP-redacted — and every judgment point is outcome-annotated where ground truth exists and periodically graded against outcomes, with graded real cases feeding its bench battery. An unlogged judgment call is an unaccountable one.
**Derives from.** *Observable Intelligence* — and extends it from call METADATA (component, model, tokens, latency, fired/noop) to decision CONTENT (the handed context, the choice, the outcome). A separate article because the obligations differ in kind: metadata is cheap and always-on; content carries disclosure risk and therefore carries the redaction/locality/retention contract as part of the rule itself.
**In practice.** Applied through `src/core/JudgmentProvenanceLog.ts` and the graded-review job; extends **Token-Audit Completeness** from cost to content.
**Earned from.** The 2026-07-10 investigation reconstructed decisions from scattered logs by hand; provenance rows would have made the root cause a read, and real incidents are the only honest battery cases.
**Traces to the goal.** Observable Intelligence — no autonomous decision is invisible, and the system's judgment measurably improves.

**Family: The Substrate — `### Ownership-Gated Side Effects`**
**Rule.** On a multi-machine pool, any actor that creates, revives, or re-binds a session — or fires topic-scoped side effects — must prove current conversation ownership at fire time; routing and ownership verdicts are binding, not advisory; a non-owner forwards, queues, or claims deliberately, never acts locally; ownership-resolution error fails toward action loudly and boundedly, never silently.
**In practice.** Applied through `src/core/SpawnAdmission.ts` and the burst-invariant E2E test; the revival actors' existing `topic-owner-elsewhere` invalidation is the precedent generalized.
**Earned from.** 2026-07-10: the Mini spawned sessions for Laptop-owned topics 6ms after its own router said not to; 2026-06-25: topic-28730 ownership-split stall.
**Traces to the goal.** One agent, many machines — exactly one voice and one owner per conversation.

## 8. Deliverables (PR checklist additions from round 1)

- Two `PostUpdateMigrator` migrations (spec-converge SKILL edit; side-effects template edit) — same PR as the skill edits.
- `generateClaudeMd()` + `migrateClaudeMd()` updates (reconciler, notices, provenance surfaces).
- `GET /pool/duplicate-reconciler` status route (enabled/dryRun, substrate readiness, per-tick counters, breaker states, last convergence, open escalations) + dashboard touchpoint beside the existing duplicateTopics badge; `GET /judgment-provenance` (redacted).
- `DEV_GATED_FEATURES` rows for all three flags; machine-coherence coherence-critical set additions; `/guards` loadBearing wiring for stale-owner-release when the ladder enforces.
- Backup-manifest exclusions (provenance dir; breaker counters ride the replicated store's existing posture).
- lint-self-heal-fields declarations (§3.8); bench batteries + registry rows (§3.4).

## Open questions

_(none — all round-1 candidates resolved into Frontloaded Decisions: Layer-D subsumption corrected in §3.2.4a/§3.2.6; J2 tail-slice pinned to the live-tail chokepoint bound in FD10; breaker counters replicated in §3.2.5; rollout sequencing vs inboundQueue + stale-owner-release pinned in §4.)_
