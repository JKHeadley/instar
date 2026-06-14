---
title: "The Agent Carries the Loop"
slug: "agent-owned-followthrough"
author: "echo"
parent-principle: "The Agent Carries the Loop"
eli16-overview: "agent-owned-followthrough.eli16.md"
lessons-engaged:
  - "Signal vs. Authority (classifier flags; deterministic taxonomy + tool-call gate hold authority)"
  - "Migration Parity (existing agents via the update path)"
  - "No Unbounded Loops (escalation brakes on the agent-drive path)"
  - "Observation Needs Structure (the sweep + the external-block governor need audit artifacts)"
  - "CMT-1101 evaporation scar (never auto-close an unverifiable-open promise)"
  - "Near-Silent Notifications (never nag ≠ never surface a terminal failure)"
  - "Challenge the Mechanism (LRN-007 — justify extending PromiseBeacon vs a workflow engine)"
  - "Close the Loop (a parked-forever external block must still surface once)"
review-convergence: "2026-06-14T04:21:33.394Z"
review-iterations: 5
review-completed-at: "2026-06-14T04:21:33.394Z"
review-report: "docs/specs/reports/agent-owned-followthrough-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Justin (operator ratification, topic 20905, 2026-06-14) — ratified the 'The Agent Carries the Loop' article + blessed the C1+C2-now / autonomy-ratchet-as-tracked-follow-on split"
---

# The Agent Carries the Loop — Commitment Ownership + Near-Silent Follow-Through

**Status:** draft — rounds 1–3 + cross-model incorporated; re-scoped to C1+C2 (v4)
**Origin:** Justin, topic 20905, 2026-06-13.
**Scope note:** The autonomy ratchet (C3 — "Blockers Are Autonomy Opportunities") is carved into a separate tracked follow-on spec (`agent-autonomy-ratchet`) — see §11. The 3-round review proved it is a larger, security-sensitive build (a new agent-grantee identity in the PIN-anchored mandate model + hardening the operation gate); bundling it would rush the most security-critical surface. C1+C2 below is the direct, self-contained fix for the parking/graveyard problem and converges on its own. The full convergence history (rounds 1–3 + all C3 findings) is preserved in §10/§11.

---

## 1. The Operator Mandate (verbatim intent)

> "the human employees/users should NEVER have to remember ANYTHING. The Instar agents have FULL responsibility of remembering ALL commitments and following through. The only time user employees get notified is after there are some results to see OR you need approval for an action you don't yet have authorization for. But even then, the goal is for every agent to always continue to gain more autonomy and trust …"

- **C1 — Zero user memory.** The agent owns all follow-through; a commitment is never resolved by the user remembering to act.
- **C2 — Notify only for results or genuine authorization.** Everything else is silent.
- **C3 — Autonomy ratchet.** (Carved to the follow-on spec — §11.)

## 2. What triggered it

I parked two of MY actions on Justin as "tracked commitments" and called it follow-through. Evidence it is systemic: the registry is a graveyard of un-closed `pending` agent promises (weeks old) — and (round-3 insight) the binary owner model would re-create that graveyard silently via `blockedOn:'external'`.

## 3. Constitution gap analysis (verified through round 2)

| Claim | Present? | Where | Gap |
|---|---|---|---|
| C2 (notify only results/auth) | ✅ standard | **Near-Silent Notifications** | Not enforced at the commitment/beacon layer. |
| C1 (no one remembers) | 🟡 partial | **No Manual Work (user *or* agent)** | Written about feature-discovery + tool-use; does NOT state "the agent owns commitment follow-through". |

**Verdict: neither enforced at the commitment layer** — a *Structure beats Willpower* failure.

## 4.0 Mechanism choice (LRN-007 — challenge the mechanism, raised by both external reviewers)

The agent-drive loop (§4.2) is effectively a small durable-workflow engine. We deliberately **extend the existing `PromiseBeacon` + escalation-ladder primitives** rather than adopt a workflow engine (Temporal / Step Functions / a queue with DLQ) because: (a) the **subscription-path constraint** forbids new always-on infra dependencies (Instar must run on a laptop with no managed queue); (b) the beacon already owns the session-lease, quota-backpressure, single-flight, and cooldown this needs — a queue would duplicate it and re-cross the same seams; (c) in-process auditability. **vs. an embedded durable-job table (round-5 codex #3 — the lighter alternative, not just managed engines):** a SQLite/file job-table + cron-scheduler is closer to viable, but the unit of work here is *driving a Claude session* (lease, quota, model-tier, single-flight, terminal Attention surfacing) — all of which PromiseBeacon already owns; a parallel job table would have to re-acquire every one of those seams and keep them in lockstep with the beacon that ALSO touches the same commitments, doubling the source of truth. The commitment store IS the durable job table; PromiseBeacon is its worker. We adopt the workflow-engine *vocabulary* honestly: idempotency key = commitment id; dead-letter = the Rung-3 terminal give-up; lease = the existing lease-holder gate.

## 4.1 Commitment state model (closes C1) — owner ⟂ blockedOn

Two **orthogonal** fields (round-2 external "fake agency" finding — the binary owner model conflated waiting-states):

- `owner: 'agent' | 'user'` — who drives the next action. **Default `agent`.**
- `blockedOn: 'none' | 'external' | 'user-input' | 'user-authorization'` — what it waits on. **Default `none`.**

Routing:
- `owner:'agent'`, `blockedOn:'none'` → the beacon drives **the agent** (§4.2): spawns/continues a session to do the work. The user is never status-messaged.
- `owner:'agent'`, `blockedOn:'external'` → the beacon does NOT actively drive (the existing primitive has no "make a live session act" verb — round-4 grounding), and **no dedicated monitoring session is spawned** (round-5 codex). A dependency-probe (`POST /commitments/:id/probe`) is recorded opportunistically whenever ANY live agent session on the topic touches the commitment; the beacon (1) suppresses all status output (§4.2), (2) runs the §4.4 staleness-window timer, (3) dead-letters once at the bound. So if no session ever touches it, it simply dead-letters at the window — the safe outcome. "Acts when ready" is the agent's session work, never a beacon action.
- `owner:'user', blockedOn:'user-input'` → surfaced **once** as a plain question (a genuine taste/preference/info need that is the user's), then waits. No nagging.
- `owner:'user', blockedOn:'user-authorization'` → handed to the follow-on ratchet (§11). Until that ships, this surfaces **once** to the operator as an **Attention-queue item / plain "I need your approval for X — I don't have authorization yet" message** (NOT the Slack-floor `/authorization-requests` flow, which is a human-user floor-grant primitive, wrong grantee model) — no standing grant minted, never a self-grant.

**The single covering invariant (round-4 adversarial):** NO `owner:'agent'` non-terminal commitment may stay silent past a bound, for ANY `blockedOn` value — `none`→§4.5 give-up; `external`→§4.4 window dead-letter; (user-routed values are `owner:'user'` by construction). A future `blockedOn` enum value MUST declare its bounded surfacing or routing rejects it.

`owner`/`blockedOn` are **agent-declared, never regex-auto-classified** (do not bolt onto `detectTimePromise`).

**Well-formedness gates at `record()` (structural only, not semantic judgment — Signal-vs-Authority):**
- Forward: `blockedOn:'user-authorization'` is rejected unless it names the specific privileged action + the authority lacked.
- Inverse: an `owner:'agent'` commitment whose work is side-effecting must self-declare an `actionClass`; the record-time check is **well-formedness on that declaration** (symmetric with forward), NOT an LLM classification of prose. **In C1+C2, `actionClass` is inert metadata — validated for well-formedness but with NO runtime consumer; it is forward-compatible plumbing for C3.** The inverse gate therefore provides NO side-effect protection today (asymmetric with the forward gate, which is load-bearing now); the actual side-effect authority remains the **existing tool-call-time `external-operation-gate`** at the real decision point — unchanged by this spec (its hardening + the standing-grant consumer that reads `actionClass` is C3/§11 work; this spec does not change its fail-posture).

**Route + replication:** `owner`/`blockedOn`/`actionClass` added to the `POST /commitments` destructure + `record()` signature. **State transitions are real but guarded (round-5 codex #4 — blanket immutability is too rigid; real commitments change as a dependency resolves / auth is granted / the agent takes ownership back):** `owner`/`blockedOn` are NOT in the plain `PATCH` allowlist (a silent PATCH transition would bypass the gate), but a dedicated `POST /commitments/:id/transition` endpoint allows a typed state change that **re-runs the forward + inverse well-formedness gates** on the new state and appends to the commitment's history (no close-and-reopen, no history fragmentation). So legitimate transitions are possible without bypassing the gate, and the gate is never skipped. They ride the existing `commitments-sync` mesh path (additive). **The enum clamp on receive is NET-NEW code** in `CommitmentsSync.applyPage` (modeled on the WS2 type-clamp-on-receive discipline — `applyPage` stores rows wholesale today with no field validation), defaulting absent/out-of-enum to `agent`/`none`. §4.2 routing has a precondition: a non-enum `blockedOn` is treated as `none` (fail-safe toward agent-drive, never an un-handled branch).

## 4.2 Beacon agent-drive — bounded; suppression enforced IN the beacon

`owner:'agent'` ⇒ the `PromiseBeacon` drives the agent, never status-messages the user. Round-3 correction: **beacon sends are `isProxy:true` and bypass `MessagingToneGate`**, so suppression is enforced **inside PromiseBeacon**.

- **Single chokepoint (round-3 NEW-5):** route every beacon user-send through one private `emitUserSend(commitment, text, kind)` helper; the owner-gate lives there, covering ALL FIVE real `sendMessage` sites (verified: fire-tail heartbeat/atRisk/liveness, `autoPause`, `closeOutTurnFinished`, `rung2`, legacy `transitionViolated`) — not a single "top of fire()" check (which misses the escalation-arm sends). The gate suppresses `kind ∈ {heartbeat, atRisk, liveness, closeOut, rung2}` under `owner:'agent'`.
- **Terminal sends always surface, via the Attention dead-letter (round-4 adversarial C):** `rung3` is already an `raiseAttention` Attention item (not a `sendMessage`) — the one always-pass surface. The legacy `transitionViolated` send (reached only when escalation is OFF, on session-loss) is a **terminal failure** — under `owner:'agent'` it MUST be re-routed to the same `raiseAttention` dead-letter (kind `terminal`), NEVER suppressed (would swallow a failure — the constitution-article violation) and NEVER sent as a topic status message (would violate C2). So a session-lost agent-owned commitment always surfaces exactly once, regardless of whether escalation is on.
- **Drive the existing session** if alive; spawn a continuation only if none is.
- **Brakes are invariants (P19):** agent-drive spawns draw from the **same** `escInFlightGlobal` / `maxConcurrentEscalations` budget as session-loss revival (ONE global ceiling), plus per-topic cooldown + `minEscalationIntervalMs` backoff + `maxEscalationAttempts` cap, gated by `GET /autonomous/can-start` + `autonomousSessions.maxConcurrent`. **The load-bearing brake for sweep-cadence drives is the per-topic cooldown + global semaphore** (not `maxEscalationSpawnsPerTick`, whose 5s window is inert on a slow cadence). Refusal → defer. **Drive only when idle/stale, never every tick.**
- **Boot-cap fix:** `owner:'user'` commitments are **exempt from / pooled separately within** `maxActiveBeacons` (the `start()` partition), so a graveyard of agent-owned rows can never crowd out a genuine user ask.
- **Terminal give-up preserved:** a genuinely-unreachable agent-owned commitment raises ONE deduped operator Attention item via the existing **Rung-3** (the dead-letter) — "never nag" ≠ "swallow a failure".

## 4.3 Near-silent enforcement (closes C2) — signal-only, scoped to the reachable path

- **B-PARK / B-IDLEAK** added to `MessagingToneGate` (signal-only; two-stage: regex pre-filter every message, LLM gate only on hit). They run on the **non-proxy conversational** path (`reply`/`automated`) — the only path the gate sees.
- **B-IDLEAK also gets a beacon-local pass** (beacon/Rung-3 text bypasses the gate and is the most likely `CMT-\d+`/`dryRun`/rung-name leaker) — the direct fix for "what is CMT?".
- **B-PARK carve-outs:** never flags an `owner:'user'` surfaced ask; never pressures the agent to absorb a genuine value/taste/spend decision (the human-only set). Fail toward sending.
- **B-IDLEAK does NOT replace** `guardProxyOutput`/`redactSecrets` (those stay authority for path/secret disclosure). B-IDLEAK is jargon-signal only — a mitigation, not a complete fix.

## 4.4 External-block staleness governor (round-3 Finding C — closes the new silent-graveyard vector)

An `owner:'agent', blockedOn:'external'` commitment that **monitors** must not be able to park forever in silence (the original failure, re-expressed). The **window dead-letter is the hard enforcement** (it fires regardless of agent behavior); the dependency-probe is the *reset* that makes "monitoring" falsifiable:

- **The bound (hard guarantee):** if a `blockedOn:'external'` commitment has no recorded dependency-probe within a bounded window (config, default 24h), it raises **ONE deduped operator Attention item** (a dead-letter via `raiseAttention`, NOT a nag, NOT a status heartbeat) — preserving "abandoned is never auto-closed" while guaranteeing a forever-parked external block cannot stay silent. This backstop fires whether or not the agent ever probed.
- **The probe (the reset):** the agent's own session records an **observable dependency-probe** via `POST /commitments/:id/probe` (what was checked + the readiness signal awaited), persisted to a new typed `lastProbe?: {at, checked, readinessSignal}` field on `Commitment` (Observation Needs Structure — the probe has a refused-without-it artifact). A fresh probe resets the window. So an agent genuinely monitoring keeps the window alive with falsifiable evidence; an agent doing nothing hits the dead-letter. The beacon does not record probes (it has no live-drive verb) — the agent's session does, which is exactly the work being monitored.
- **The absolute ceiling (round-5 codex #2 / adversarial N1 — prevents a false-liveness probe loop):** a probe resets the window but NOT an absolute lifetime. After a hard cap (config, default e.g. 14 days OR N probes), the commitment dead-letters ONCE regardless of probes — a "still worth waiting on this?" surface — so an agent cannot indefinitely reset a 24h window with low-quality probes ("checked inbox, no update") and silently park forever. The probe keeps a genuinely-active wait alive *up to* the ceiling, never past it.

## 4.5 Graveyard reconciliation — evidence-gated, dry-run-first, bounded

- **Auto-close ONLY on objective evidence** (`deliveryMessageId` present / a verification method that now passes / a named superseding id). **"abandoned" is NEVER an auto-close** (CMT-1101 scar); an unverifiable-but-open promise routes to agent-drive or surfaces after a bounded give-up.
- **Bounded:** `maxClosesPerPass` + a **slow cadence (hourly), NOT the 60s `verify()` interval**. Closes buffered in-memory, flushed once per pass via a new `mutateBatch` primitive (CommitmentTracker has none today) — else bounded per-record writes.
- **Every close writes a disposition-evidence record;** lease-gated (one machine). The **one-time graveyard drain closes legacy rows with honest disposition only — never spawn-revives them**.

## 4.6 Observability (Observable Intelligence) — incl. the silent-drive governor

`/metrics/features` (B-PARK/B-IDLEAK via the `CircuitBreakingIntelligenceProvider` funnel + `attribution.component`) + an extended `escalationMetrics()` sibling: guard fire/noop rates; agent-drive `spawnsRequested`/`spawnsRefused{quota,cap,cooldown}`/`droveExistingSession`; `agentOwnedActive`/`userInputActive`/`externalBlockedActive`; reconciler closes-by-disposition + sweep-run + external-block-governor audit rows. (A C2/C3 drift governor — agent-owned-share trend — is part of the §11 ratchet follow-on, since it governs the autonomy gradient that C3 introduces.)

## 4.7 Migration parity (P3)

- **`owner`/`blockedOn`/`actionClass` back-fill in `CommitmentTracker.loadStore()`** (`owner ??= 'agent'`, `blockedOn ??= 'none'`; never silently classify legacy as `user-authorization`). NOT config migration.
- **CLAUDE.md awareness (P5):** `generateClaudeMd()` section + content-sniffed `migrateClaudeMd` patch (idempotency marker).
- **Constitution article (gated on ratification):** `docs/STANDARDS-REGISTRY.md` is prose, not a table — so the article lands under its `###` heading with an italic **`*(proposed <date>, pending operator ratification)*`** parenthetical (the exact mechanism the "Observable Intelligence" article uses), carrying NO enforcement weight until Justin's ratification ACK removes the parenthetical. There is no `status:` field.
- **Config defaults** (§4.8) via `migrateConfig`/`applyDefaults` add-missing.

## 4.8 Rollout — dark + dryRun, live-on-dev

Behind `commitments.agentOwnedFollowthrough` (`enabled` + `dryRun`: in dry-run logs "would drive / would surface", spawns/messages nothing). Dark on fleet, live-on-dev (developmentAgent gate). Named rollback knob + `GET` status surface. Signal-only B-PARK/B-IDLEAK safe to ship live, still maturation-gated.

## Frontloaded Decisions

- **FD1 — owner ⟂ blockedOn state model** (two orthogonal fields; not a binary owner) so external-waiting and user-input are not mislabeled as agent-agency.
- **FD2 — Constitution article (operator-ratified):** §9 draft; lands under its heading with an italic `*(proposed …, pending operator ratification)*` parenthetical (zero enforcement, matching the Observable-Intelligence precedent) until Justin ratifies. Build proceeds on code in parallel.
- **FD3 — Reconciler + external-block governor safety:** dry-run-first; evidence-gated; "abandoned" never auto-closed; bounded per-pass + slow cadence; external block surfaces once after the window.
- **FD4 — Suppression chokepoint:** one `emitUserSend()` owner-gate covering all emit sites; Rung-3 dead-letter always passes.
- **FD5 — C3 (ratchet) is a tracked follow-on spec** (§11), not in this scope — recommended for Justin's ratification.

## 9. Constitution article (draft — operator-ratified; lands under its heading with an italic *(proposed …, pending operator ratification)* parenthetical, zero enforcement until ACK)

**(Substrate) "The Agent Carries the Loop."** A commitment is the agent's obligation to act, not the user's obligation to remember. It may never resolve by the user remembering to act. The only legitimate user-facing pull is a usable result, a genuine authorization the agent lacks, or a genuine user-input/taste decision that is theirs — each surfaced once, never nagged. "Never nag" never means "swallow a terminal failure."

## 6. UX walkthrough
- (agent-owned, incl. external-blocked) User asks for X → agent does X / monitors the dependency → user sees a single RESULT. No "tracked, your call".
- (user-input) Agent genuinely needs the user's info/taste decision → one plain question, then waits.
- (forever-blocked-external) The dependency never resolves → after the window, ONE honest dead-letter ("I've been waiting on X for N days — it hasn't moved; want me to drop it or keep waiting?").

## 7. Agency assessment
Scales with `agentAutonomy.level` (the `.capabilities` field does not exist). Standing-grant accrual is the §11 follow-on.

## 8. Decision points touched
- New signal-only: B-PARK, B-IDLEAK (flag, never block) on the conversational path + a beacon-local B-IDLEAK pass.
- New structural validation: forward + inverse `owner`/`blockedOn` well-formedness at `record()` (the real side-effect authority is the existing tool-call gate, unchanged here).
- Modified behavior: `PromiseBeacon` owner-routing via the `emitUserSend()` chokepoint, gated/dark per §4.8.

## Open questions

*(none)*

## 10. Convergence history (rounds 1–3)
- **R1 (6 internal + gate):** ~30 findings; the ratchet was the dangerous part → reshaped onto the PIN-anchored mandate, spawn brakes, evidence-gated reconciler, migration, dark rollout.
- **R2 (6 internal + codex/gemini):** owner⟂blockedOn ("fake agency"), substrate-fit, beacon isProxy bypass, always-ask floor → v3.
- **R3 (6 internal + codex/gemini):** decision-completeness CONVERGED, scalability ZERO new; remaining material findings were all C3-rooted (see §11) → **scope decision: split**. C1+C2 fixes applied here (external-block governor §4.4; emit chokepoint §4.2).

## 11. Carved out — C3 "Blockers Are Autonomy Opportunities" (tracked follow-on `agent-autonomy-ratchet`)
A REGISTERED, driven follow-on (not a park). **Close-the-Loop cadence (round-4 R4-1):** a named slug is not a cadence — so a durable **commitment is opened now** ("author + converge the `agent-autonomy-ratchet` spec") that re-surfaces until deliberately closed, **dogfooding the very mechanism this spec hardens**. (The C3 ratchet is the direct expression of the operator's headline intent in §1 — "always continue to gain more autonomy" — so deferring it without a cadence would risk deferring the headline ask; the commitment prevents that.) It inherits these grounded findings as its starting constraints:
- The grant must be a NEW agent-grantee (`grantedToAgentFp`) extension of `UserAuthorityGrant`, signed via the PIN-gated `MandateStore`; agent Bearer = zero authority; only operator PIN mints; requester≠authorizer. `grantedToAgentFp` MUST be brought under `canonicalMandate`'s authProof (else forgeable).
- The named consumer (`external-operation-gate`) is **net-new, security-critical** work: the hook today **fails OPEN**, is FloorAction-blind, sees only `mcp__*` (Bash ungated), sends **no agent fingerprint**, and `MandateBackedGrantStore` is Slack-user-keyed. The ratchet needs: server-bound agentFp plumbing (never body-trusted — `/operations/evaluate` is shared-Bearer), an agent-keyed `activeGrant`, fail-closed-for-agent-sessions, a Bash-surface policy, and `actionClass`↔risk-axis mapping.
- Pinned to the real `FloorAction` enum (`money-movement|prod-deploy|credential-access|destructive-data|external-send|grant-authority`), **NO floor action is agent-ratchet-eligible** (all high-risk → always ask). The ratchet's real domain is the **operational/low-medium risk tier**. `RATCHET_ELIGIBLE_ACTIONS` is a POSITIVE allowlist; `grant-authority`+`prod-deploy` explicitly never.
- Bounded ≤24h leases (renew, don't accrue); parameterized scoped capabilities (account/cap/recipient/rate/window — enforcing `bounds` is net-new); an aggregate-ceiling that GATES new mints; a C2/C3 drift governor.
- Article "Blockers Are Autonomy Opportunities" ratifies with that spec.

## 12. Test plan (Testing Integrity — all tiers)
- **Unit:** forward + inverse well-formedness gates; owner⟂blockedOn routing (all four combos); the `emitUserSend()` chokepoint suppresses heartbeat/atRisk/liveness/closeOut/rung2 under owner:agent AND passes rung3; B-PARK/B-IDLEAK both sides incl. carve-outs + the beacon-local pass; external-block governor fires once after the window + the dependency-probe requirement; reconciler evidence-gated + "abandoned"-never-closed + CMT-1101 regression + maxClosesPerPass; enum clamp on `commitments-sync` receive.
- **Wiring-integrity (P4):** beacon owner-routing deps not null/no-op, delegate to real impls.
- **Integration:** `/commitments` with owner/blockedOn; metrics surfaced.
- **E2E:** feature alive (200 not 503); a `user-input` commitment surfaces once + never re-nags; dry-run spawns/messages nothing.
- **Sustained-failure (P19):** drive a permanently-failing target; bounded attempts + Rung-3 fires once.
- **Test-as-Self:** drive a real commitment lifecycle over Telegram; user messaged ONLY on result / user-input / terminal dead-letter.
- **Migration parity:** existing agents get the fields via `loadStore()` back-fill + the CLAUDE.md patch; graveyard reconciled without spawn-storm.
