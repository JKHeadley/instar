---
title: "Autonomous Throughput Floor — the manager-side mentee-output forcing function"
slug: "autonomous-throughput-floor"
author: "echo"
status: draft
approved: false
parent-principle: "Close the Loop / Deferral = Deletion — an autonomous manager that goes idle while non-gated work exists has silently abandoned the loop"
lessons-engaged:
  - "Structure > Willpower (the manager must not rely on REMEMBERING to keep the mentee fed — a forcing function makes 'manager idle while work exists' structurally visible)"
  - "Judgment Within Floors (the legitimate-HOLD permission is a deterministic INVARIANT, never LLM-delegated; the classifier may narrow the action but may never AUTHORIZE a hold)"
  - "Capacity Safety — No Unbounded Self-Action (re-dispatch/re-task is a registered self-action controller: convergence-ratchet test + restart-survival corollary + a per-mentee aggregate breaker)"
  - "No Unbounded Loops (P19: cap AND backoff AND breaker on every self-action; restart may not mint a fresh budget vs unchanged pressure)"
  - "An Instar Agent Is Always a Multi-Machine Entity (P21 — the ACTUATION is machine-local; the breaker/counter CONVERGENCE state RIDES THE RUN so a move/restart cannot reset the P19 budget)"
  - "Know Your Principal — An Unverified Identity Is a Guess (the mentee-liveness read binds to the mentee's verified fingerprint; auto-dispatch is provenance-tagged floor-generated, never conflatable with an operator instruction)"
  - "No Silent Degradation to Brittle Fallback (an unreachable mentee-liveness read fails toward SURFACING 'I can't see the mentee', never toward a false 'all fine'; and effect is judged by a real deliverable delta, not a send-ACK)"
  - "Conservative Outbound: Act, Don't Notify (this spec is the WORK-side twin — 'nothing shipped' triggers ACTION exactly as 'nothing to say' triggers silence)"
  - "The Agent Carries the Loop (a lane/commitment is the agent's to finish, never the user's to chase)"
  - "Maturation Path (ships dark on fleet, live-on-dev, dry-run FIRST; the action-bearing flip earns a named soak success-criterion)"
  - "Bounded Notification Surface (P17 — one aggregated operator item on a flapping-mentee breaker trip, never one-per-tick)"
  - "Anti-confabulation / Verify the State Not Its Symbol (an intervention is only 'effective' with a verified follow-on deliverable delta; a send-ACK alone records DELIVERED, not EFFECTIVE)"
  - "Token-Audit Completeness + Decision Provenance (the flatline classifier carries attribution.component AND enrolls in the JudgmentProvenanceLog + decision-quality meter)"
  - "Migration Parity + Agent Awareness (migrateConfig entry + CLAUDE.md template + DEV_GATED_FEATURES + self-action lane-member ratchet)"
single-run-completable: true
---

# Autonomous Throughput Floor

> **Round 2 (2026-07-20).** Reshaped by round-1 convergence (3 internal reviewers + cross-model codex-cli:gpt-5.5, ~20 material findings). The load-bearing changes: (1) the legitimate-HOLD permission is now a DETERMINISTIC INVARIANT, never LLM-judged (the classifier can no longer synthesize "blocked-on-user" to re-license the founding passive hold); (2) breaker/counter CONVERGENCE state RIDES THE RUN — a topic-move or a manager-machine restart can no longer reset the P19 budget; (3) the cross-agent signal is grounded on infra that ACTUALLY exists (`GET /threadline/peers/health` ack-liveness + the manager's existing git-SHA sweep) — the richer mentee-output probe + full auto-refeed backlog are a NAMED, SCOPED follow-on (§10), because they require genuinely new mentee-side foundation; (4) the re-dispatch controller is REGISTERED under Capacity Safety with an explicit amplifying / fail-closed / pool-shared governor policy; (5) effect is judged by a real deliverable delta (EFFECT-ACK), not a send-ACK.

## 0. Grounding — what this is, is NOT, and its authority basis (read first)

An autonomous session with a continuous-progress purpose (an apprenticeship drive, a long build, a migration) has a **manager** turn-loop that dispatches work to one or more **mentee/worker** agents and observes their output. The failure this spec closes: the manager **decays into a passive watch-loop** — it wakes on a timer, sweeps for merged work, finds none, re-arms the timer, and holds — producing zero forward motion **while non-gated work exists**. The manager LOOKS busy (it ticks) but is idle in the only sense that matters (deliverable throughput). This is the WORK-side twin of *Conservative Outbound: Act, Don't Notify* — "nothing shipped" must trigger ACTION exactly as "nothing to say" triggers silence-to-the-user; conflating the two disciplines is the bug.

**This feature ACTS (it re-dispatches / surfaces / holds) — so it is NOT "signal, not authority."** It is honestly framed as: **it acts within a deterministic Judgment-Within-Floors envelope, under Capacity-Safety brakes, and it never blocks an outbound message.** Its acting authority is NOT exempt from the self-action obligations (§8).

**Authority basis for cross-agent re-dispatch (§5).** Re-dispatching work to a mentee is an **A2A write** — it makes a separate agent on a separate machine do real, cost-bearing work. A2A is deny-by-default (Coordination Mandate). The floor's authority to re-dispatch comes ONLY from an **operator-preauthorized autonomous run** (the run registration under `POST /autonomous/register` IS the operator's standing pre-authorization for the manager to drive that run's mentee) OR an explicit drive mandate; absent that, the floor may SURFACE but MUST NOT dispatch. The manager's authority to *send* is never authority over what the mentee *does*: the mentee's own external-operation / coherence gates independently re-evaluate every re-dispatched task.

It is NOT any of the existing surfaces (verified against source at origin/main v1.3.889):
- **not** `AutonomousProgressHeartbeat` — posts a liveness line to the USER; never acts to restore MENTEE throughput.
- **not** `AutonomousLivenessReconciler` — self-heals a run with NO live session (dead-but-active respawn); the floor targets an alive manager whose mentee's deliverable OUTPUT flatlined.
- **not** `SubagentTracker`/`HelperWatchdog` — same-process framework subagents; the mentee is a separate agent on a separate machine (a distinct Threadline fingerprint), invisible to them.
- It SHARES machinery with `AutonomousProgressHeartbeat` (active-run iteration, per-run backoff ladder, dryRun/guardStatus scaffolding) and REUSES `SelfActionGovernor` for brakes — it introduces no new external engine for the CORE (§3–§9). The richer mentee-output probe (§10) is the one genuinely-new integration and is scoped separately.

## 1. The founding incident (Drive 7, run through the CLASS-review — the un-skippable meta-rule)

Class-review of record: `.instar/drive7/autonomous-throughput-floor-classreview.md` (ACT-847). The incident it distills: the last mentee deliverable merged ~20:53 PDT; from ~22:06 to ~09:43 (~11.5h) the manager did ONE live mentee read, inferred "progressing," then held in a timer-paced observe loop (wake → sweep → "no merge" → re-arm → hold) — zero active intervention while the mentee sat parked at an approval gate with non-gated lanes available. Root cause: the manager **conflated conservative-sends (a messaging rule) with conservative-action (do nothing)**. The session existed to TEST throughput and its MANAGER became the bottleneck.

**Class question:** what standard + infra makes an autonomous MANAGER structurally CONVERT "mentee output has gone quiet" into "act" (a live check + re-task) instead of decaying into a passive watch-loop — WITHOUT the "act" becoming its own unbounded/ungoverned self-action, and WITHOUT the classifier being able to rationalize a hold?

## 2. The existing foundation (build ON, do NOT duplicate) — verified at origin/main v1.3.889

| Surface | File / route | What it does today | Relation to the floor |
|---|---|---|---|
| AutonomousProgressHeartbeat | `src/monitoring/AutonomousProgressHeartbeat.ts` | User-facing liveness line on user-silence + own-terminal-change | Floor SHARES its active-run iteration + backoff scaffolding; distinct purpose (mentee-output, act-not-notify). |
| AutonomousLivenessReconciler | `src/monitoring/AutonomousLivenessReconciler.ts` (`GET /autonomous/liveness`) | Respawns a run marked active with no live session; guards `movedTo`/mid-move + `ownerElsewhere`/`!leaseHeld` (criteria 4–5) | Floor ADOPTS its ownership/lease/mid-move gate verbatim (§7). |
| Autonomous run registry | `POST /autonomous/register`, `GET /autonomous/sessions` (`src/core/AutonomousSessions.ts`) | Start snapshot (config, condition, git base SHAs) | Floor reads the run record + condition; the lane-BACKLOG structure it needs for auto-refeed does NOT exist here yet → §10. |
| Threadline peer health | `GET /threadline/peers/health` → `A2ADeliveryTracker.allPeerHealth()` | Per-peer delivery/ACK liveness: `lastSentAt/lastAckedAt/lastInboundAt/pendingCount/stale` | This is the REAL cheap cross-agent signal the floor uses in v1 (§4) — NOT a deliverable-output probe. |
| SelfActionGovernor | `src/monitoring/.../policies.ts` (ControllerPolicy) | Admission + P19 brakes on self-triggered actions | Floor REGISTERS a controller with an explicit policy (§8); an unregistered emit is refused by the forcing lint. |

The mesh transport connects **my own machines**, not a separate agent; Codey/Luna are distinct fingerprints reached over **Threadline (message-passing)**, not a synchronous HTTP health probe. v1 therefore reads what genuinely exists (peers/health ack-liveness + the manager's git-SHA sweep) and defers the rich `{lastDeliverableAt, activeLaneCount, lastStateSignal}` mentee-output surface to §10.

## 3. Mechanism — the Throughput Floor monitor (v1, on existing foundation)

### 3.1 The signal (measures MENTEE OUTPUT, meaningful-delta floor, manager-blind)

Per tick (`throughputFloor.tickMs`, default 15 min) compute a **meaningful deliverable-delta** for the active run since the last tick, from records the manager already has (read the LAST sweep's CACHED result — never trigger a fresh network call on the tick). **The flatline window is reset ONLY by real work throughput, never by mere liveness** (cross-model round-2 finding: an inbound ACK proves message *processing*, not *output*, and routine chatter/protocol noise must not mask a non-producing mentee — that IS the founding "looks alive but isn't producing" failure):

- **the ONLY meaningful delta = a monotonic deliverable advance** — a NEW merged PR or an advanced PR head SHA on the run's mentee branches (authoritative branch set = the run record's declared repo/branch scope). A lane-status flip (dispatched→building) is NOT a meaningful delta (S-M6: a flapping mentee that re-parks manufactures a notch/cycle and defeats the window), and **an inbound-ACK advance is NOT a meaningful delta either** — it is only work-liveness, not work-output.
- `peers/health.lastInboundAt` (EXCLUDING any message the MANAGER itself just authored — S-M6) is used ONLY to DISTINGUISH mentee liveness in the §3.2 classification (alive-and-processing vs STALLED vs UNREACHABLE); it NEVER resets the flatline window. So a mentee that keeps ACKing messages but ships nothing correctly FLATLINES (and classifies IDLE/alive, not PRODUCING) — the exact founding case.

`meaningfulDelta = 0` across the whole run for longer than `throughputFloor.flatlineMs` (default **75 min**) = a **FLATLINE**. The signal is the MENTEE's OUTPUT, never the manager's own wake/sweep count and never mere mentee liveness — a manager that woke 40 times and swept clean, or a mentee that ACKs but never ships, both have deliverable-delta ZERO, which is the point.

### 3.2 The action ladder on flatline (deterministic-invariant-gated)

Every rung is gated on **"THIS machine owns the run + holds the lease + is not mid-move"** (adopting `AutonomousLivenessReconciler` criteria 4–5 + the heartbeat's `movedTo`/`moveSuspended` suppress) and admitted through the `SelfActionGovernor` controller (§8). On a confirmed flatline:

1. **Live mentee-state read** (§4). Classify STRUCTURAL-PRIMARY (§4.1): PRODUCING / STALLED / IDLE / UNREACHABLE.
   - **PRODUCING** (a monotonic deliverable advanced, or `lastInboundAt` advanced on non-manager traffic) → not a flatline; record corroboration, reset the window, hold this tick. (The anti-thrash guard — heavy convergence must not read as a stall. NOTE this rung is signal-anchored, NOT a free "hold" — it requires a REAL advance, so it cannot be a hold-rationalization.)
   - **STALLED** (a stopped-session signal is the mentee's newest structural state) → **re-dispatch** to re-spawn (§5), success judged by EFFECT-ACK (§5).
   - **IDLE** (alive, `pendingCount:0`, no advancing deliverable, no active lane) → **surface + (Phase 2) auto-refeed** the next backlog lane (§10). In v1, IDLE with an operator-preauthorized run → re-dispatch the next known priority; without a lane-backlog structure it SURFACES the idle to the operator rather than guessing a lane.
   - **UNREACHABLE** (the read failed) → SURFACE honestly (§4.2 fail-safe); do NOT assume PRODUCING or IDLE; apply UNREACHABLE backoff.
2. **The legitimate-HOLD permission is a DETERMINISTIC INVARIANT — NOT an LLM verdict** (this is the load-bearing round-2 fix, per Judgment Within Floors §538). A hold this tick is permitted ONLY when BOTH:
   - `blockedOnUser == true` derived from an **actual open approval-gate record** (a commitment with `blockedOn:user-authorization`/`user-input`, or an open operator-approval item for the run) — NEVER from the classifier inferring "the mentee seems to be waiting"; AND
   - `allNonGatedLanesSaturated == true` derived from a **deterministic live count** reconciled against live lane state (not a stale backlog record).

   The LLM may classify the mentee STATE (PRODUCING/STALLED/IDLE) but may **NEVER** be the authority that AUTHORIZES a hold. If the two deterministic conditions are not both true, a hold is structurally forbidden — the ladder MUST act (re-dispatch / surface). This closes the founding rationalization: the classifier can no longer synthesize "blocked-on-user" to license a passive hold.

**Operator absolute-HOLD veto (deny-wins, classification-independent):** an operator-set HOLD marker on a run/lane (a `[HOLD]`-style marker / mandate pause) is a deny-wins veto — a deliberately-parked run is NEVER re-dispatched regardless of classification (green-PR-automerge HOLD precedent). Auto-dispatches are **provenance-tagged floor-generated** so the mentee never conflates them with an operator instruction (Know Your Principal).

**P19 / Capacity Safety brakes (§8):** cap, exponential backoff, a per-run breaker AND a **per-MENTEE aggregate breaker** (across all runs and machines — the only key a run/machine-multiplication cannot dodge), all keyed on EFFECT (§5) not on send-ACK. A tripped breaker escalates ONCE (one aggregated operator attention item) then observes. Under budget/quota pressure the ladder FAILS CLOSED — it holds+surfaces, never dispatches (§8 spend gate).

## 4. The cross-agent mentee-liveness read (v1 = real infra; rich probe = §10)

### 4.1 v1 signal (grounded on what exists)
- **Primary:** `GET /threadline/peers/health` for the mentee's **verified fingerprint** → `{ lastInboundAt, lastAckedAt, pendingCount, stale }` (ack-liveness), joined with the manager's existing **git-SHA sweep** (deliverable advance). Classification is STRUCTURAL: STALLED requires a structural stopped-session signal; PRODUCING requires a monotonic deliverable advance or non-manager inbound-ack advance; IDLE = alive + no advance + no active lane; UNREACHABLE = health read failed.
- **Know Your Principal:** the read binds to the mentee's canonical fingerprint (never a name from content); for a non-fleet mentee it routes through verified-pairing/trust, never raw mesh.
- **No prose all-clear:** any LLM step over mentee output treats it as delimited, neutralized untrusted data (the `<replicated-untrusted-data>` / cartographer-summary precedent) and may only LOWER confidence — it may NEVER assert PRODUCING on prose alone (S-M3: suppression is the dangerous direction; a false "fine" is the silent killer).

### 4.2 Fail-safe (No Silent Degradation)
If the read is unreachable → return `UNREACHABLE`, SURFACE "I cannot see the mentee's state," apply a probe backoff on consecutive UNREACHABLE, and NEVER fabricate a verdict. An unreachable mentee is itself a reachability finding worth an operator breadcrumb.

### 4.3 Secret egress
The v1 signal is STRUCTURAL (fingerprints, timestamps, SHAs, counts) — no raw mentee output crosses the wire. If the §10 richer probe is built, its payload is scrubbed at the SOURCE (mentee side, reusing the AutonomousProgressHeartbeat credential/secret/path scrub, drop-to-generic on match) before it crosses the mesh. Every §5 intervention audit row is **metadata-only** (classification enum, ts, ok, laneId) — NEVER raw output or message bodies.

## 5. Re-dispatch / re-task (effect-ACK, authority, anti-confabulation)

A re-dispatch rides the mentee's USER channel (never a back-door API), is **provenance-tagged floor-generated**, carries an idempotency `externalKey` (per lane+dispatch, so two sends = one start), and is authorized only under an operator-preauthorized run (§0). It is recorded:
- **DELIVERED** on a verified `ok:true + ts` from the actual send (anti-confabulation: no described-but-unmade dispatch);
- **EFFECTIVE** only on a subsequent REAL deliverable delta within a bounded window after the dispatch (EFFECT-ACK). A send-ok with no follow-on delta records as **no-effect/FAILED** and COUNTS toward the breaker + grows the backoff (S-M4: a dead mentee still returns ok:true, so send-ACK alone must never count as success).

The mentee's own external-operation/coherence gates independently re-evaluate the re-dispatched task (authority to send ≠ authority over what the mentee does).

## 6. Standards deltas this spec proposes (into the amendment loop — operator ratifies)

1. **NEW standard — Autonomous Throughput Floor.** *Rule:* in an autonomous session whose purpose is continuous progress, a flatline in real mentee deliverable output past a bounded threshold MUST trigger a mandatory active intervention (live check → re-task/re-dispatch/surface), NOT a passive hold; a legitimate hold requires BOTH a deterministic blocked-on-user record AND deterministic all-non-gated-lanes-saturated. *In-practice:* "nothing shipped" triggers action exactly as "nothing to say" triggers silence. *Earned-from:* the Drive-7 ~9h manager-idle incident (ACT-847). *Applied-through (teeth):* (a) this runtime monitor for registered autonomous runs; (b) a `/spec-converge` lessons-aware reviewer lens ("does an autonomous-manager spec permit a hold without the two deterministic conditions?"); (c) a behavioral detector analogous to `MessagingToneGate` B15–B18 for the in-session "passive-hold-while-non-gated-work-exists" rationalization (the self-stop family is the precedent — a "I'll just watch" is detectable the same way a fatigue/context self-stop is). Without (b)+(c) the rule would govern only this monitor and merely cheer elsewhere (L-M5).
2. **NEW standard — Delegation-Default** (elevating the Jul-19 operator directive to constitutional status — it is currently only a memory note, NOT a ratified standard, so this PROPOSES it rather than "sharpens" a phantom, L-M3). *Rule:* in an active apprenticeship/overseer relationship, discovered/available work routes to the mentee by default; the overseer must justify KEEPING any load-bearing task, and "I can do it faster" is not a valid justification. *Applied-through:* the auto-refeed (§10) is its runtime arm (a freed lane auto-dispatches the next item, budget-and-ceiling-aware).

Both are Instar-general (me↔Codey now, any overseer↔mentee, Luna next). A manager that can silently idle for hours is, by definition, not load-bearing. Positioned as the work-side twin of *Conservative Outbound: Act, Don't Notify*.

## 7. Multi-machine posture (P21 — decomposed; state RIDES THE RUN)

The round-1 reviewers converged here: a single `machine-local` label was WRONG because it conflated actuation-locality with state-locality and let a topic-move/restart reset the P19 budget. Decomposed:

- **The acting turn-loop (actuation): machine-local BY DESIGN** — only the machine hosting the manager loop can intervene. `machine-local-justification: hardware-bound-resource` (the running manager turn-loop is bound to the executing process/machine; a peer cannot intervene on a run it does not host). *(This marker line is in the front-matter-parseable `## Multi-machine posture` form so `scripts/lint-machine-local-justification.js` parses it.)*
- **The breaker / cap / flatline-window CONVERGENCE state: RIDES THE RUN (carried on transfer; NOT machine-local).** It is topic-scoped, not process-bound. On a `POST /pool/transfer` it moves with the run-state (alongside the `moved_to` markers on the working-set carrier); the SelfActionGovernor controller class is declared `resource: 'pool-shared'` so the count ceiling is cross-machine (proactive-swap-monitor precedent). **Restart-survival corollary (P19 §503):** a manager-machine restart or a topic-move MUST NOT mint a fresh intervention budget against unchanged pressure — the breaker state is reconstructed from the durable run-carried record, never re-armed to zero.
- **Ownership/lease/mid-move gate:** every ladder rung gates on THIS machine owning + holding-lease + not-mid-move (adopting the reconciler's criteria 4–5), so a transfer window cannot produce a double re-dispatch.
- **Operator escalation** (flapping-mentee breaker trip): one aggregated attention item through the existing bounded surface.

## 8. Capacity Safety — registered self-action controller (obligations discharged)

Re-dispatch/re-task/auto-refeed are self-triggered actions under sustained pressure (the "No Unbounded Self-Action" class — the 17,503-kills/day + 72-swaps/day ancestors). Obligations:

- **Register** the controller in `SELF_ACTION_CONTROLLERS` / `src/testing/selfActionRegistry.ts` (an unregistered emit is refused by `scripts/lint-no-unregistered-self-action.js` at commit).
- **Governor policy (explicit, not defaulted):** `direction: 'amplifying'` (it creates cross-agent load), `failDirection: 'closed-queue'` (a governor admit-path error must HOLD, never fire — the neutral default fails OPEN, wrong here), `resource: 'pool-shared'` (ties §7 — cross-machine ceiling). The floor's own P19 breaker is the `delegatedGiveUp` authority (the `liveness-reconciler-respawn` model), so the two brakes compose rather than double-count.
- **Convergence ratchet:** pass `tests/unit/self-action-convergence.test.ts` — N ticks under pinned sustained pressure yield total actions < a small K and NOT scaling with the horizon.
- **Restart-survival:** the machine-local acting loop reconstructs breaker state from the run-carried record (§7) — proven reset-safe.
- **Per-mentee aggregate breaker** (across runs+machines) backed by a receiver-side inbound-dispatch limit on the mentee (§10 — the mentee-side floor is the un-dodgeable key).
- **Spend gate (fail-closed):** the action-bearing flip AND every dispatch consult the existing quota-aware placement + budget gates; under budget/quota pressure the ladder holds+surfaces, never dispatches (S-M8). Auto-refeed additionally skips a rate-limited/quota-blocked mentee.

## 9. Testing, deployment, migration, guards (Testing Integrity + Maturation + Migration Parity + Agent Awareness)

- **Unit:** meaningful-delta computation (a lane-flip is NOT a delta; a monotonic SHA advance IS; the manager's own message is excluded); the ladder classification; the DETERMINISTIC hold-invariant (a synthesized "blocked-on-user" without an open-approval-gate record does NOT permit a hold); effect-ACK (send-ok + no delta = FAILED); the P19 convergence-ratchet + restart-survival + per-mentee breaker.
- **Integration:** `GET /autonomous/throughput-floor` returns per-run window/counters/breaker; a simulated flatline drives one gated intervention with an EFFECT-ACK-required, metadata-only audit row; an unreachable read surfaces UNREACHABLE (never a fabricated verdict); the ownership/lease/mid-move gate blocks a non-owner tick.
- **E2E:** the feature is alive on a dev agent in observe-only (LOGS the intended intervention without dispatching) — "feature is alive, 200 not 503."
- **Maturation:** dark on fleet, live-on-dev, **dry-run FIRST**. The action-bearing flip (`dryRun:false`) earns a NAMED soak success-criterion (JWF evidence-before-authority): *in soak, ≥N flatlines correctly classified with ZERO false re-dispatches vs. the hold-default.*
- **Decision Provenance:** the flatline classifier enrolls in the `JudgmentProvenanceLog` + decision-quality meter (the founding incident IS a judgment-quality problem) AND carries `attribution.component` (Token-Audit).
- **Migration Parity + Agent Awareness (NON-NEGOTIABLE):** a `migrateConfig()` entry for the `monitoring.throughputFloor` block; a `DEV_GATED_FEATURES` entry (`configPath: 'monitoring.throughputFloor.enabled'`) + a `guardStatus()` feeding `GET /guards` (`loadBearing:false` — a bounded forcing function); the self-action lane-member ratchet entry; and a CLAUDE.md template addition (curl example for `GET /autonomous/throughput-floor` + the proactive trigger).
- **Rollback:** `enabled:false` degrades to today's behavior (manager judgment + timers); a stranded run-carried window record is inert.

## 10. Named, scoped follow-on (NOT this v1 — genuinely new foundation)

Two pieces the round-1 reviewers correctly identified as new foundation (and therefore honestly scoped OUT of v1, not deferred-by-avoidance — each requires a second agent's surface / a new persisted structure that cannot be built inside this monitor alone):

- **10a — the rich mentee-output probe (two-ended).** A cheap `{ alive, lastDeliverableAt, activeLaneCount, lastStateSignal }` surface the MENTEE exposes over an authenticated, fingerprint-bound, receiver-rate-limited, source-scrubbed Threadline request/response — replacing v1's ack-liveness+SHA approximation with a direct deliverable-rate read. Requires building the mentee side; specced as its own increment. Until then v1's structural signal (§4.1) is the floor's input.
- **10b — the persisted lane-backlog + auto-refeed.** A standing prioritized lane-record structure on the run (the run registry today snapshots config+SHAs, NOT a lane backlog), so a freed lane auto-dispatches the next item (Delegation-Default's runtime arm, §6.2), budget-and-ceiling-aware, respecting the mentee's declared concurrency ceiling (source: the run/instance record) and mentee quota. Until then v1 SURFACES an IDLE mentee to the operator rather than guessing a lane.

v1 ships the CORE forcing function (flatline → deterministic-gated live-check → surface/re-dispatch, Capacity-Safety-registered, breaker-rides-run) — which is what actually prevents the Drive-7 failure — on real existing foundation. 10a/10b make it richer.

## Frontloaded Decisions

- **FD-A (flatline threshold):** 75 min default (class-review 60–90 band). Config, reversible — cheap.
- **FD-B (v1 signal = peers/health ack-liveness + git-SHA sweep; rich probe = §10):** the v1 signal is grounded on existing infra; the §10 probe is a NAMED separate increment with a REQUIRED two-ended contract (NOT cheap — a published cross-agent interface — hence scoped out of v1, not tagged cheap).
- **FD-C (posture decomposed):** actuation machine-local (`hardware-bound-resource`, marker in §7); breaker/counter state RIDES THE RUN (unified-carried). Contested both directions and resolved: unified is infeasible for actuation, machine-local is infeasible for the breaker budget (restart-survival) — hence the decomposition, not a single label.
- **FD-D (dark + dry-run-first, named flip criterion):** observe-only soak with the §9 success-criterion before the action-bearing flip. Reversible.
- **FD-E (effect-ACK, not send-ACK):** an intervention is EFFECTIVE only on a follow-on deliverable delta; send-ok+no-delta = FAILED for breaker+backoff. Not cheap-tagged — it's a core correctness invariant.
- **FD-F (auto-refeed respects the mentee concurrency ceiling + quota):** §10b; ceiling source = run/instance record; skips a quota-blocked mentee.
- **FD-G (authority basis = operator-preauthorized run):** the run registration is the operator's standing pre-authorization; absent it, surface-only. Not cheap — it's the A2A-authority basis.

## Decision points touched

- **The flatline→action decision (§3.2 ladder): `judgment-candidate`.** Floor: a bounded action space (read / re-dispatch / surface / hold), a conservative default (UNREACHABLE or ambiguous → surface + hold-safe, never blind re-dispatch), and a deterministic terminal rung (breaker → escalate once → observe). The mentee-STATE classification (PRODUCING/STALLED/IDLE) is intelligence-assisted over STRUCTURAL-PRIMARY signals + neutralized untrusted-data; every rung is P19-braked; it never blocks a message and never re-dispatches without an operator-preauthorized run + an EFFECT-ACK success test.
- **The legitimate-HOLD permission: `invariant` (NOT delegated).** This is the load-bearing round-2 correction (Judgment Within Floors): a hold is permitted ONLY on TWO deterministic conditions (an open approval-gate record + a live-reconciled all-lanes-saturated count). The classifier may narrow the ACTION but may NEVER authorize a hold — otherwise it could synthesize "blocked-on-user" and re-license the founding passive hold.

## Open questions

*(none blocking — FD-A..G frontload the reversible calls; §10 names the two genuinely-new-foundation pieces as scoped follow-ons with required contracts, so the buildable v1 has no un-frontloaded mid-run stop. The one design commitment worth an explicit operator nod at approval: the §6 proposal to ADD "Delegation-Default" as a new constitutional standard, since it is currently only a memory directive.)*
