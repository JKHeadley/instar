# Ownership-Gated Spawn, Duplicate Reconciliation & Judgment-Within-Floors

**Status:** DRAFT — pre-convergence.
**Operator directive:** Justin, topic 11960, 2026-07-10 ("yes please!", 19:40 PDT) — ship the duplicate-session fix as the first live instance of the judgment-within-floors pattern, and ratify the supporting standards in the same cycle.
**Ancestor incidents:** 2026-07-10 duplicate cross-machine sessions (topics 29723 + 29836, root-caused with logs — §1); 2026-07-05 recurrence (Mini duplicate of `echo-llm-pathway-characterization` remote-closed); 2026-06-25 topic-28730 ownership-split stall (forwarding-side sibling).
**Grounding:** all `file:line` anchors verified against upstream/main @ 7406c8e61 (2026-07-10) by three independent code-recon passes.

---

## 0. Constitutional Traceability (required by the Constitutional Traceability standard)

| This spec | Standard |
|---|---|
| Binding router verdict at spawn callsites | **Signal vs. Authority** (the incident is the canonical violation: verdict computed at `src/commands/server.ts:2484`, discarded by the `acked`-keyed short-circuit at `:2537`) |
| One enforced decision seam for session creation | **Structure > Willpower** |
| Owner-dark ladder always answers or honestly notifies; resolution-error fails toward spawn, loudly | **The Agent Is Always Reachable**; silent-loss-refusal-conservation §2.D |
| Reconciler converges duplicates automatically, confirm-ticks + veto breaker | **Close the Loop**; **Bounded Blast Radius**; P19 |
| Arbiter calls attributed, metered, benched, provenance-logged | **Observable Intelligence**; **Token-Audit Completeness**; **Intelligent Prompts** |
| Arbiter = mind informs, floor = body constrains, every call audited | **The Body and the Mind** / `docs/signal-vs-authority.md` ("make it *inform* the mind instead, and audit the call") |
| **NEW standard: Judgment Within Floors** | Gap: nothing tells a builder when a decision point should be LLM judgment vs static code (Part-B ratification) |
| **NEW standard: Decision Provenance & Outcome Review** | Gap: no requirement that LLM decisions log full context and get outcome-graded (Part-B ratification) |
| **NEW standard: Ownership-Gated Side Effects** | Gap: nothing requires session-creating/reviving actors to prove conversation ownership at fire time (Part-B ratification) |

Per Part B, approval of this spec ratifies the three standards; their registry text is §7.

## 1. The incident (evidence-grounded)

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
`pool.duplicateTopics` is computed inside `GET /sessions` scope=pool (`src/server/routes.ts:7468-7532`): same `${platform}:${platformId}` live on ≥2 machines (headless/jobs excluded). Nothing consumes it beyond the dashboard badge.

### 2.3 Why the existing closeout could not heal this
The post-transfer closeout — immediate half at `src/commands/server.ts:21982-22006`, reaper-tick sweeper via `SessionReaper` (`src/monitoring/SessionReaper.ts:1009-1024`, terminate at `:893-958`, config `topicMovedCloseout:true`, `topicMovedConfirmTicks:2`, `topicMovedVetoBreakerAttempts:5` at `:153-155`, F8 lease carve-out `bypassLeaseForTopicMovedCloseout` at `:919-928`) — is gated on `topicOwnerElsewhere` = `reg.ownerOf(topicId) !== self` (`src/commands/server.ts:8972-8979`). A deliberate move WRITES that ownership record; an independently-spawned duplicate does not. On the Mini the registry had NO active record for these topics (hence `owner=?` in the route log), so `ownerOf` gave nothing to compare and the sweeper never fired. **The missing piece is not a new closer — it is a converged ownership record.** Note also the two-source-of-truth wrinkle: the Mini's PIN store knew the Laptop held 29836 (`hard-pin-unsatisfiable`) while its ownership registry held no record; §3.2 reconciles both.

### 2.4 Revival actors are already ownership-gated (verified — narrows this spec)
- `ResumeQueueDrainer.validateReality` (`src/monitoring/ResumeQueueDrainer.ts:594-643`) invalidates on `live-session-exists`, `topic-owner-elsewhere`, `resume-uuid-stale`, `binding-mismatch`, `operator-stop`, `autonomous-run-finished`, `commitment-no-longer-active`.
- `AutonomousLivenessReconciler` blocks on `topicOwnerElsewhere || !holdsLease` (`src/monitoring/AutonomousLivenessReconciler.ts:365-372`), already-live (`:379-393`), queue-owns (`:394-403`), and re-checks all of it at the actuation instant (`:622-644`).
So the unguarded creation paths are exactly: **the interactive inbound spawn/respawn fall-through (§2.1)** and any actor relying on an ownership record that was never written (§2.3). This spec closes those two; it does not rebuild what already works.

### 2.5 Reap immunity
The authority skip ladder (`SessionManager.terminateSession`, `src/core/SessionManager.ts:1311-1430`): protected → not-lease-holder (`:1344-1348`) → ReapGuard cascade (`src/core/ReapGuard.ts:131-224`: spawn-grace, recovery-in-flight, pending-injection, relay-lease, recent-user-message, open-commitment, active-subagent, structural-long-work, active-process; guard-error → KEEP) → in-flight. The Laptop's copies were shielded by `not-lease-holder`, the Mini's by `open-commitment`. Each guard is individually correct; jointly they make a duplicate immortal. The existing precedent for a narrow bypass is `bypassLeaseForTopicMovedCloseout` (`SessionManager.ts:1280-1294`).

## 3. Design

Four deterministic layers (A–D) + two LLM judgment points (J1, J2) inside them.

### 3.1 Layer A — Binding verdict at the spawn seam (prevention)
**A new `SpawnAdmission` check, consulted at every session-creating callsite for a conversation-bound topic** (Telegram cold-spawn `:2691`, Telegram respawn `:2613/:2631`, Slack `:9048/:9358`; the drain tail and revival actors already gate). Mechanics:
1. `resolveOwnershipSafe(sessionKey)` — a non-throwing tri-state wrapper over the ownership registry returning `{kind: 'self' | 'other-alive' | 'other-dark' | 'unowned' | 'error'}` (closes the §2.1 ambiguity; `other-dark` derives from the existing `isMachineAlive` input; `error` catches registry read failures instead of leaking a throw into the handler's fail-open catch).
2. Admission table (deterministic floor):
   - `self` → spawn (today's behavior).
   - `other-alive` → forward (existing owner-side inject; today's behavior when routing works).
   - `other-dark` → **never spawn locally.** Run the owner-dark ladder (§3.3).
   - `unowned` → route through `placeAndClaim` and spawn ONLY as the claimed owner (the router already does this; the seam makes its result binding).
   - `error` → spawn locally (reachability wins over a broken store) + one journal row + one deduped attention item (loud fail-open — never silent).
3. The `queued`/`placement-blocked` verdicts suppress local spawn **independently of `acked`**: if the durable queue is dark, the fallback is the deterministic G1-style notice path (§3.3 rung 3), not the legacy spawn.
4. Single-machine installs / pool `dark`: the seam short-circuits to `spawn` — byte-identical behavior, zero regression.
Rollout flag: `multiMachine.sessionPool.ownershipGatedSpawn` (dev-gated, dryRun first: logs would-suppress verdicts while the legacy fall-through still runs).

### 3.2 Layer B — Duplicate reconciler = converge the ownership record (auto-heal)
The insight from §2.3: the closing machinery already exists and is already safe (confirm ticks, veto breaker, work guards, protected checks). What is missing is the ownership record on the non-owner machine. The reconciler therefore:
1. Runs on the lease holder, piggybacking the same per-peer poll that already computes `duplicateTopics` (`routes.ts:7468-7532` extraction shared, no new fan-out).
2. For each duplicate `(topic, machines[])` with no in-flight transfer: determine the intended owner (§3.2.1), then **converge the record** — write/repair the ownership registry (and pin-store coherence) via the existing CAS verbs (`SessionOwnershipRegistry.cas`, `src/core/SessionOwnershipRegistry.ts:182`) so every machine's registry names the same owner.
3. The existing post-transfer closeout sweeper then closes non-owner copies through its normal gated path (`topicMovedCloseout`, 2 confirm ticks, veto breaker, F8 carve-out) — reap-log reason extended to name `duplicate-reconciled`. No new killer is introduced.
4. **Survivor floor (deterministic):** owner's copy survives by default; a non-owner copy that is mid-turn / carrying live subagents defers via the existing work-gate probe (`SessionRefresh.consultWorkGate`, `src/core/SessionRefresh.ts:413-426` / `SessionManager.probeWorkState`); a non-owner copy driving a LIVE autonomous run is never closed — ownership MOVES to it via the deliberate transfer path instead; protected sessions never auto-closed; last-unanswered-message re-injection via `resolveUnansweredInbound` (`SessionRefresh.ts:196-198`) on the surviving copy.
5. **P19 breaker:** a topic re-duplicating ≥3 times in 24h stops being auto-reconciled and raises ONE attention item.
6. **Layer D fallout:** because the reconciler converges the RECORD, the `not-lease-holder`/`open-commitment` reap shields stop mattering for duplicates — the closeout path (which carries its own lease carve-out) does the work. A separate reap carve-out is NOT built (candidate simplification adopted; reviewers: challenge this).

#### 3.2.1 Intended-owner determination
Deterministic default: pin-store hard pin wins; else the machine the ownership registry (any machine's replicated view) most recently recorded as active owner; else the machine with the live AUTONOMOUS RUN; else the machine with the most recent user interaction on that topic. Ambiguity across those rules → judgment point J2 (§3.4); J2 unavailable → the first rule that produces an answer, and if none, escalate ONE attention item (never guess silently).
Rollout flag: `multiMachine.sessionPool.duplicateReconciler` (dev-gated, dryRun first: logs intended convergence without writing records).

### 3.3 The owner-dark ladder (Layer A's `other-dark` arm)
1. **Hold** — the existing hold-for-stability shape (`holdVerdict`, `src/commands/server.ts:21258-21268`; `holdMaxMs:90000`, `src/core/inboundQueueConfig.ts:77-79`). A blip never moves a conversation.
2. **Claim-then-spawn** — if the owner is provably dead per the stale-owner-release evidence bar, the claim goes through the existing single CAS funnel (`StaleOwnerReleaseEngine.actForceClaim` → `reconciler.actStaleOwnerForceClaim`, `src/commands/server.ts:19339`); the new owner then spawns as `self`. One-owner stays invariant; the user is answered by the surviving machine.
3. **Queue + honest notice** — death unprovable (wobbly-but-alive): durable-queue when the inbound queue is live; when it is dark, the deterministic floor is the G1-style notice ("that machine is mid-restart — your message is queued and will be answered when it returns; resend if urgent") on the cold-start-lifeline deterministic path, plus retry on owner return. Never a bootleg spawn; never silence.
Rung choice timing (how long to hold, whether to proceed to claim evaluation early, when to notify) is **judgment point J1**. The floor alone is complete: fixed hold window → claim if evidence bar passes → notice. A hard ceiling on user-visible silence applies regardless of J1's choice.

### 3.4 The judgment points (first live instances of Judgment Within Floors)
Shared contract (this IS the new standard, applied):
- **Bounded action space** — the model picks among options the floor proved safe; invalid/omitted/timeout → deterministic default. The floor can only be narrowed, never widened.
- **Bench-laddered fallback** — the arbiter model resolves via the routing registry's per-task record `{default, fallbacks[], floor}`; below-floor or all-doors-down → the deterministic default. The last rung is always static (the incident-correlated failure mode is all doorways degraded at once — the 2026-07-10 outage would have degraded the judge with the judged).
- **Never on the happy path** — invoked only on the ambiguous branch (`other-dark`; contested survivor). Zero added latency otherwise.
- **Provenance-logged** (§3.5), attributed, metered, benched.

**J1 — owner-dark rung arbiter** (`attribution.component: 'OwnerDarkArbiter'`). Context: crash-loop signature (supervisor kill cadence, boot progress from the replicated journal), heartbeat/git-sync recency, rope health, that machine's outage history, queue depth, message urgency. Action space: `{keep-holding≤ceiling, queue+notify-now, proceed-to-claim-evaluation}`. J1 proposes; the claim itself still passes the mechanical evidence bar — J1 can NEVER authorize a claim.

**J2 — survivor arbiter** (`attribution.component: 'DuplicateSurvivorArbiter'`). Context: both copies' recent tmux tails (redacted via the live-tail chokepoint, quoted as untrusted data), autonomous-run state location, open commitments, session ages, last user interaction. Action space: `{owner-copy-survives, move-ownership-to-working-copy, defer-one-tick, escalate-to-attention}`. All §3.2.4 floor guards apply regardless of choice.

**Registry obligations (mechanical, each CI-ratcheted):** each arbiter joins `COMPONENT_CATEGORY` (`src/core/componentCategories.ts:36`), `LLM_BENCH_COVERAGE` (`src/data/llmBenchCoverage.ts:32`), `natureRoutingMap.ts`, a row in `docs/LLM-ROUTING-REGISTRY.md` (freshness lint), and a parity-checked battery `research/llm-pathway-bench/instar-bench-v2/tasks/{owner-dark-arbiter,duplicate-survivor}.json` (`source` anchor + `promptFidelity: verbatim`, cases across the five stress axes, seeded from the 2026-07-10 and 2026-07-05 incidents as the first real cases). Precedent: `ExternalHogClassifier` ("kill-SAFETY carried entirely by the deterministic floor").

### 3.5 Decision provenance & outcome review (net-new capability)
Verified gap: no durable full-context log exists today — `ResponseReviewDecisionLog` deliberately caps at 200 scrubbed chars + `contextMeta` (`src/core/CoherenceGate.ts:1552-1580`). This layer adds one:
- **`JudgmentProvenanceLog`** (JSONL + rotation, per machine): one row per arbiter call — full context snapshot as handed to the model, options presented, decision + stated reason, floor bounds in force, model/door, tokens, latency, fallback rung. Bodies pass the `scrubString` chokepoint (`src/core/CredentialAuditEmit.ts`) and follow the `FailureDetail {redacted, full}` split (`src/monitoring/FailureLedger.ts:74`): the full body never leaves via HTTP; the HTTP surface serves redacted rows. Retention bounded (default 30 days), rotation via SafeFsExecutor.
- **Outcome annotation:** ground truth is appended when it arrives — owner-return timestamps (already journaled), reconciler results, resend/complaint signals; mechanical where possible, review-time otherwise.
- **Graded review:** a cadenced, budget-capped, tier-1-supervised job (off by default, like `bench-refresh`) replays sampled rows with outcomes attached and grades correct / wrong-but-reasonable / wrong; verdicts per judgment point route to needs-stronger-model vs needs-better-prompt vs needs-better-context; graded real cases feed the battery. Review NEVER regrades floors — only choices within them. Output: ONE digest attention item, operator-review-gated exactly like bench routing diffs.

### 3.6 The structural question (enforcement hook)
Two insertion points, both existing gates:
- **spec-converge:** a new structurally-checked question beside Standards A/B (`skills/spec-converge/SKILL.md`): every spec's `## Decision points touched` section must classify each decision point as `invariant` (deterministic, justified) or `judgment-candidate` (floor + arbiter declared, or an argued exemption). The convergence-tag writer refuses to stamp with the classification missing — same pattern as the open-questions refusal.
- **instar-dev side-effects review:** a new numbered question in `skills/instar-dev/templates/side-effects-artifact.md`: "Does this change add a static heuristic at a competing-signals decision point? If yes: why is it not a judgment point within a floor?" — enforced by the existing pre-commit/pre-push artifact gates.
- **failure pipeline:** `FailureRecord` gains `judgmentCandidate?: boolean`; the analyzer's tsc-total `RECOMMENDATION_BY_CATEGORY` forces the paired recommendation text when the enum widens.

## 4. Rollout (graduated)

1. **Increment 1:** `resolveOwnershipSafe` + SpawnAdmission seam + reconciler, ALL dryRun (would-verdicts logged; legacy behavior unchanged). Provenance log ships with the seam (it logs deterministic verdicts too — the soak data IS the future battery seed).
2. **Increment 2:** flip A+B enforcing on the dev pool with deterministic defaults only (J1/J2 branches take static defaults). This pool recurs the bug — the perfect soak.
3. **Increment 3:** J1/J2 arbiters in shadow (decide-and-log, not act); batteries land; parity-check covers them.
4. **Increment 4:** arbiters act within floors; graded-review job available (off by default). Fleet flip per increment only after quiet soak; every flag independently reversible; the §3.6 gate questions land with increment 1 (they are process, not runtime).

## 5. Test plan (Testing Integrity — all three tiers)

- **Unit:** tri-state resolver (each kind incl. thrown-registry → `error`); admission table exhaustive; ladder rung transitions + silence ceiling; intended-owner rules incl. ambiguity → J2 → static fallback; arbiter clamps (invalid/omitted/timeout/below-floor → default, action-space violation rejected); provenance writer schema + scrub + {redacted,full} split; breaker.
- **Integration:** inbound → owner-dark → notice path over real HTTP (queue dark AND live); duplicate formed → record converged → closeout closes non-owner copy (stubbed peer relay); work-gate deferral; arbiters stubbed to EVERY option proving floors hold under each; single-machine byte-identical short-circuit.
- **E2E:** feature-alive (routes 200 not 503 where surfaced); **the burst invariant:** a non-owner machine receiving N inbound messages for owned-elsewhere topics creates ZERO local sessions and exactly the queued/notice artifacts (mirrors the notification-flood burst test); duplicate-reconciliation lifecycle on a two-node harness.
- **Ratchets joined:** llm-attribution, bench-coverage, routing-registry freshness, no-unbounded-llm-spawn (arbiters ride `buildIntelligenceProvider`).

## 6. Decision points touched (per §3.6, eating our own cooking)

| Decision | Classification | Why |
|---|---|---|
| May this machine spawn for this topic? | **invariant** | one-owner-per-conversation; delegated judgment here IS the incident |
| Owner-dark: how long to hold / when to notify / when to evaluate claim | **judgment-candidate → J1** | competing signals, prediction from messy evidence |
| Is the owner provably dead (claim authorization)? | **invariant** | evidence bar stays mechanical; J1 proposes only |
| Which duplicate survives? | **judgment-candidate → J2** | contested work evidence; static rules are the proven failure (`open-commitment` immortality) |
| Close a copy mid-turn? | **invariant** | never — work-gate floor |
| Provenance body redaction | **invariant** | scrub chokepoint, never judgment |

## 7. Standards registry text (three `###` articles; enforcement guards named per the auditor's resolution rules)

**Family: Building — `### Judgment Within Floors`**
**Rule.** A decision point with competing signals or non-enumerable context may be delegated to an LLM arbiter only inside a deterministic floor: the floor defines the complete safe action space and a conservative default; invariants are never delegated; the arbiter can narrow but never widen; fallback follows the bench-ranked ladder and always ends at a deterministic rung. A new static heuristic at such a point must state why it is not a judgment point.
**In practice.** Applied through `src/core/SpawnAdmission.ts` (J1 floor) and the duplicate reconciler survivor floor; contested per-spec via the spec-converge decision-point classification and per-change via the side-effects question; arbiters join the four routing registries and carry parity-checked batteries.
**Earned from.** 2026-07-10 duplicate-session incident: the static reap heuristics (`open-commitment`, `not-lease-holder`) made duplicates immortal, while the missing enforcement of an already-computed verdict caused them.
**Traces to the goal.** The mind decides within the body's constraints; neither substitutes for the other.

**Family: Building — `### Decision Provenance & Outcome Review`**
**Rule.** Every LLM judgment call durably logs the full context it was handed and the decision it made — scrubbed, retention-bounded, machine-local-full/HTTP-redacted — and every judgment point is outcome-annotated where ground truth exists and periodically graded against outcomes, with graded real cases feeding its bench battery. An unlogged judgment call is an unaccountable one.
**In practice.** Applied through `src/core/JudgmentProvenanceLog.ts` and the graded-review job; extends **Token-Audit Completeness** from cost to content.
**Earned from.** The 2026-07-10 investigation reconstructed decisions from scattered logs by hand; provenance rows would have made the root cause a read, and real incidents are the only honest battery cases.
**Traces to the goal.** Observable Intelligence — no autonomous decision is invisible, and the system's judgment measurably improves.

**Family: The Substrate — `### Ownership-Gated Side Effects`**
**Rule.** On a multi-machine pool, any actor that creates, revives, or re-binds a session — or fires topic-scoped side effects — must prove current conversation ownership at fire time; routing and ownership verdicts are binding, not advisory; a non-owner forwards, queues, or claims deliberately, never acts locally; ownership-resolution error fails toward action loudly, never silently.
**In practice.** Applied through `src/core/SpawnAdmission.ts` and the burst-invariant E2E test; the revival actors' existing `topic-owner-elsewhere` invalidation is the precedent generalized.
**Earned from.** 2026-07-10: the Mini spawned sessions for Laptop-owned topics 6ms after its own router said not to; 2026-06-25: topic-28730 ownership-split stall.
**Traces to the goal.** One agent, many machines — exactly one voice and one owner per conversation.

## 8. Open questions

_(none yet — convergence reviewers populate; author's candidate challenges: is Layer D truly subsumed by B (§3.2.6)? J2 tail-slice size vs PII (§3.4)? pool-shared vs per-machine breaker counters (§3.2.5)? sequencing against the inboundQueue rollout ladder?)_
