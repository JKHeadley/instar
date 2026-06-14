---
title: "Promise-Beacon Escalation — a promise survives its owning session's death"
slug: "promise-beacon-escalation"
author: "echo"
parent-principle: "Close the Loop"
eli16-overview: "promise-beacon-escalation.eli16.md"
review-convergence: "2026-06-13T03:46:46.401Z"
review-iterations: 5
review-completed-at: "2026-06-13T03:46:46.401Z"
review-report: "docs/specs/reports/promise-beacon-escalation-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 1
contested-then-cleared: 1
approved: true
approved-by: "justin"
approved-at: "2026-06-13T04:46:00Z"
---

# Promise-Beacon Escalation — a promise survives its owning session's death

**Status:** CONVERGED (rounds 1–5; internal panel clean at round 5, external refinements absorbed)
**Issue:** JKHeadley/instar#1093
**Constitutional anchor:** *Close the Loop* (`docs/STANDARDS-REGISTRY.md`) — "Every loop the agent opens — a promise to a user — must be durably registered and re-surfaced on a cadence until it reaches a *deliberate* close." Today a promise whose owning session dies is silently terminalized (`violated: session-lost`); this spec adds the missing rung that re-surfaces it *into action*, not just into a postmortem record. Bound equally by **No Unbounded Loops** (the escalation ladder is a loop → backoff + breaker + cap, structurally) and **Signal vs. Authority** (the beacon SIGNALS; it never seizes new authority to mutate external state — see §3.0).

---

## 1. The incident this fixes (live, 2026-06-12)

Echo promised Justin a dashboard link "the moment it's live" and registered it durably as **CMT-1419** (one-time-action, beacon-eligible) at ~14:26 PDT. The owning session went silent ~14:40 PDT. The commitment sat **open in the registry for ~3.5 hours** while the user heard nothing actionable. At 17:52 Justin: *"You made it sound like you would get back to me but you never did."*

The registry did its job — a new session could reconstruct exactly what was promised. What failed is the **follow-through arm**: nothing converted *open commitment + dead owning session* into either (a) a fresh agent turn that re-engages, or (b) an honest interim status to the user.

## 2. Current behavior (verified in source, v1.3.506)

`PromiseBeacon.fire()` (`src/monitoring/PromiseBeacon.ts`):

- **Session-epoch check** (lines ~384–392): if the commitment's stamped `sessionEpoch` differs from the live epoch of the session bound to its `topicId`, it calls `transitionViolated(c, 'session-lost')` and returns.
- **`transitionViolated`** (lines ~586–600): sets `status: 'violated'`, sends a one-shot `⚠️ … violated: session-lost`, then `stopFor(id)` — **terminal**. Because `fire()` early-returns on `status !== 'pending'`, every subsequent heartbeat is a no-op.
- **When `getSessionForTopic(topicId)` returns `null`**: the epoch block is *skipped*; the beacon emits a generic templated "still working" heartbeat — **misleading**, since nothing is working.

Net: the promise is silently tombstoned or papered over with a false "still working" — never re-engaged, never honestly reported.

## 3. Design — the escalation ladder

### 3.0 Authority model (the load-bearing decision — Signal vs. Authority)

**Escalation confers NO new authority.** The beacon is a signal-only classifier; it must not become an actor that mutates external state on stale context. Therefore:

- **Rung 1 re-creates a turn; it does not grant power.** The revived session is a *normal* session, fully bound by every existing gate — the external-operation-gate (`mcp__*` classification + `/operations/evaluate`), the Coherence Gate, mandate checks, and trust levels. Escalation cannot do anything a normal session at that topic could not already do.
- **Status-first is ENFORCED STATE, not a prompt wish** (Structure > Willpower — round 2, codex#4). A revived session is spawned carrying a machine-readable **`revivalMode: status-only-until-revalidated`** marker (passed at spawn, written to the session's durable record). The external-operation-gate reads this marker and **blocks every side-effecting tool** (`mcp__*` writes, git push, deploys, any non-read external operation) until the commitment carries a **server-recorded revalidation** (below). Until then the session can only read, reason, and *report*. The guarantee is the gate, not the prose: even a misbehaving revived turn cannot mutate external state before revalidating.
- **Revalidation is a server-recorded transition, NOT a self-attested checkbox** (round 3 — internal + codex independently). The revived session requests revalidation via a server endpoint `POST /commitments/:id/revalidate` carrying required evidence (a non-empty restated current-intent summary + the matching `escalationAttemptId`). The SERVER writes a durable `revalidatedAt` + `revalidatedBy` (the authenticated session id) onto the commitment; the external-operation-gate unblocks side-effects ONLY when `revalidatedAt` is present, recent (within `revalidationTtlMs`, default 30 min), and matches the live session. The session cannot set `revalidatedAt` directly (I11 makes it server-written-only), so it cannot self-clear the gate. **What revalidation PROVES, stated honestly (round 4, codex#1):** it is a *liveness + deliberate-pause* checkpoint — it proves a live, authenticated revived session paused and restated current intent before being allowed to act. It does NOT semantically verify the intent is correct (a revived session could restate stale intent and regain access). It is therefore a *speed-bump that forces a deliberate re-think under the existing gates*, not a semantic safety oracle — the strong protection remains the per-action external-operation/coherence gates that every session already passes. For genuinely high-risk action classes, those gates (and, where configured, mandate checks / user confirmation) are the real barrier; revalidation just guarantees the revived turn cannot blindly auto-continue without one explicit re-thinking step.
- **The injected prompt** (the human-readable half) instructs the revived session to (a) re-establish what was promised, (b) send the user an **honest status whose FIRST user-facing line discloses staleness** when material context may have changed ("picking this back up after my session ended — some of what I assumed may have moved", round 5, codex#1), (c) treat the original promise as **possibly stale** (ephemeral workspace state — in-flight tool results, dev-server ports, auth/unstaged files — may be gone; verify prerequisites before acting), and (d) revalidate explicitly before any side-effecting step.
- **v1 scope is "re-engage and report," not "auto-complete arbitrary work."** This is a **Frontloaded Decision** (§10, FD-1): v1 deliberately does not add a separate per-commitment "may auto-execute?" gate — instead the `revivalMode` gate above structurally holds side-effects until revalidation, layered on the per-action gates the agent already enforces. It is frontloaded here precisely because it touches autonomous external side-effects — never "cheap-to-change-after."

### 3.1 Rung 1 — Revive-and-inject (preferred, status-first)
Re-deliver the commitment into a **fresh live session bound to the commitment's `topicId`** so an agent turn happens.
- **Reuse the existing spawn/inject path** — `SpawnRequestManager` (the same surface the mid-work ResumeQueue and Telegram bridge use). No second spawn primitive.
- **Injected CONTINUATION payload (concrete shape — I8).** Delivered as a single structured block: a fixed natural-language instruction (the §3.0 conservative prompt), then the commitment data as a **fenced, JSON-serialized, separately-labelled `data` block** — `commitmentId`, `userRequest`, `agentResponse`, `escalationAttemptId`, `revivalMode` — each string field length-capped (`maxInjectFieldChars`, default 2000) and truncated with an explicit `…[truncated]` marker. The promise text is presented as DATA the session is summarizing, never as instructions to obey. **The fencing REDUCES instruction-confusion; it is not an absolute injection-proof barrier** (round 3, codex#5 — "cannot inject" is too strong for LLM behavior). The real containment is the `revivalMode` side-effect gate (I13): even if a directive embedded in `userRequest` influences the revived session's *prose*, it cannot produce an external mutation before server-recorded revalidation. A test asserts malicious commitment text cannot drive a side-effecting tool call.
- **Idempotency (I6) — enforced at the spawn surface, not just beacon-side.** BEFORE the spawn, durably persist `escalationAttemptId` (uuid) + `lastEscalationAt` + increment `escalationAttempts` via `CommitmentTracker.mutate()` (CAS), and set `escalationInFlight`. The spawn request to `SpawnRequestManager` carries `escalationAttemptId` as an **idempotency key**: a second spawn request with the same key is a no-op at the spawn layer (deduped there), so even a beacon-side marker loss or a process crash between persist and spawn cannot produce two live sessions for one attempt. The in-flight marker is resolved deterministically by the timeout contract above (never an open-ended wait).
- **Revive-confirmation is owned by `fire()`, on a deterministic timeout — never an open-ended wait** (closes the spawn-then-crash deadlock, round 2). The escalating tick does NOT block waiting for the revive. It sets `escalationInFlight` + `lastEscalationAt` and returns. On each subsequent tick, for a commitment with `escalationInFlight: true`, `fire()` resolves the in-flight escalation deterministically:
  - **Confirmed** — a live session is bound to the topic, its epoch differs from the (now stale) stamped one, and it has been alive ≥ `reviveSettleMs` (default 30s): re-stamp `sessionEpoch` to the new session, keep `status: 'pending'`, clear `escalationInFlight` + `currentRung`. Normal heartbeats resume.
  - **Failed** — `now − lastEscalationAt > reviveSettleMs + escalationGraceMs` (grace default 10s) with no confirmed live session (spawn refused silently, or session came up and died before settling): the attempt has already been counted (incremented before spawn, I1), so just **clear `escalationInFlight`**. The next eligible tick re-evaluates under the I1 backoff + cap — Rung 1 retry if under cap, else Rung 2/3. The in-flight flag can therefore never wedge a commitment permanently.

### 3.2 Rung 2 — Honest interim status (fallback)
If Rung 1 cannot run — spawn refused (session cap, quota pressure, not owner machine, topic unbound, escalation disabled) OR the global concurrency budget (§4 I9) is exhausted this tick — send the user a **truthful, condition-specific** templated message (no LLM call):
**Wording is conditional on a precise recoverability state — one approved template per state** (round 4 codex#3, round 5 codex#2), so a truthful message is never operationally ambiguous:
| State | When | Approved message shape |
|---|---|---|
| `retryable` | Rung 1 will retry under backoff | "Still on *<excerpt>* — my session ended; I'm picking it back up." |
| `owner-gone` | Phase-1, topic's machine is gone, no auto-resume | "Still open: *<excerpt>*. My session ended and I can't auto-resume this right now — an operator may need to step in." |
| `quota-limited` | spawn refused on quota/load | "Still open: *<excerpt>*. Paused while I'm at capacity; I'll resume when there's headroom." |
| `disabled` | escalation off / dry-run | (no user message — audit only) |
| `operator-needed` | Rung-2 budget exhausted → handed to Attention | "I couldn't get back to *<excerpt>* automatically; I've flagged it for <operator>." |
It never claims "working" when nothing is, and never promises a resume it cannot make.
- **Secret-safe excerpt (I10):** the excerpt is redacted (drops tokens/keys/`secret`/`password` patterns); if the remainder is unsafe, a generic "an action I promised you" is used.
- Leaves the commitment `pending` + `atRisk`. **Rung 2 messaging does NOT consume the Rung-1 attempt cap** (§4 I1) — it is separately rate-limited per commitment (at most one Rung-2 message per `rung2MinIntervalMs`, default 30 min, de-duplicated by content) AND **globally/per-topic budgeted (I12)**: after a mass reap, Rung-2 sends are aggregated into **one digest per topic per `rung2DigestWindowMs`** ("3 things I owe you are paused because my sessions ended — …"). Digest selection (round 3, internal#3): a commitment is included only if it hit Rung 2 this window AND has not sent a Rung-2 message within its own `rung2MinIntervalMs` — so the digest never violates the per-commitment floor, and an excluded still-at-risk commitment surfaces in a later window rather than being dropped.
- **Truthful spam is still spam — bounded (round 3, codex#3).** Repeated "still paused" over a long unrecoverable outage is itself a failure mode. Rung-2 notifications per commitment are capped at `rung2MaxNotifications` (default 4) on escalating backoff; once exhausted while the owner remains gone, the commitment escalates to **Rung 3 / operator Attention** (an unrecoverable promise the operator should see) rather than messaging the user indefinitely.
- **Quiet-hours re-gate (I7):** Rung 2 re-checks `inQuietHours()` immediately before sending; suppressed during quiet hours.

### 3.3 Rung 3 — Bounded give-up (terminal, loud)
Only after Rung-1 escalation has **failed `maxEscalationAttempts` times** (default 3) with the backoff in §4 I1 does the commitment transition to `violated: session-lost-unrecovered`, AND a single **Attention-queue** item (existing aggregated path; dedup key = commitment id; raised once per commitment lifetime, persisted so a restart cannot re-raise it) is surfaced to the operator. This preserves today's postmortem value while removing the silent-death failure mode.

### 3.4 State-machine delta (reconciled with `paused`/`atRisk`/`beaconSuppressed`)
| Event | status | fields set/cleared |
|---|---|---|
| session-lost detected, escalation eligible | `pending` (unchanged) | set `escalationInFlight`, `escalationAttemptId`, `lastEscalationAt`, `escalationAttempts++`, `currentRung='1'` |
| Rung 1 revive confirmed (live session, new epoch, alive ≥ reviveSettleMs) | `pending` | re-stamp `sessionEpoch`; clear `escalationInFlight`; `currentRung=null` |
| Rung 1 revive failed (no confirmed session by `reviveSettleMs + escalationGraceMs`) | `pending` | clear `escalationInFlight` (attempt already counted); next tick re-evaluates under backoff/cap |
| Rung 1 refused / budget-shed → Rung 2 | `pending` + `atRisk:true` | `currentRung='2'`; set `lastRung2At` |
| `maxEscalationAttempts` exhausted → Rung 3 | `violated` | `resolution='session-lost-unrecovered'`; raise Attention (deduped); `stopFor` |
| commitment already `delivered`/`expired`/`cancelled`/`paused` | unchanged | escalation never runs (I3) |

`paused` commitments are NEVER escalated — a deliberate pause is not a dead session.

## 4. Safety invariants (No Unbounded Loops — backoff + breaker + cap)

- **I1 — Capped + backed-off, durably.** Per-commitment Rung-1 attempts are capped at `maxEscalationAttempts` (default 3). Interval between attempts uses **exponential backoff**: `max(minEscalationIntervalMs, 2^(attempt-1) × minEscalationIntervalMs)`, so a fast-dying (OOM/poisoned) revive backs off instead of hammering (gemini#2). Counters are **durable cold-state on the Commitment**, mutated via CAS — a server restart cannot reset the cap (the 2026-06-05 "restart resets the loop guard" class). Attempt is incremented **before** the spawn (so a revive that dies pre-delivery still advances the count).
- **I2 — Single-flight per topic, fair across a topic's commitments, coordinated with ResumeQueue.** At most one in-flight revive per `topicId` (a topic = one session, so one revive). To avoid one poisoned commitment monopolizing the topic lane and starving its siblings (round 3, codex#2): the coordinator key is `promise-escalation:<topicId>:<commitmentId>` for accounting, under a topic-wide concurrency cap of 1 in-flight revive, with **round-robin fairness** — a commitment that just held the lane goes to the back; a commitment in I1 backoff yields the lane to a ready sibling. **ResumeQueue owns mid-work session revival**; before Rung 1 spawns, the beacon checks whether the topic already has a live/queued ResumeQueue entry — if so it **defers to Rung 2** (no double-spawn). Spec-level ownership rule, not hand-waved.
- **I3 — Only `pending` non-paused commitments escalate.** Terminal + `paused` states are untouched.
- **I4 — Owner-machine scoped (Phase-1 honest posture).** Escalation runs ONLY on the machine that holds the topic (the `speakerElection.decide()` / `ownerMachineId` gate, **re-checked immediately before the spawn**, not just at `fire()` entry — closes the elect-then-spawn race). A standby NEVER spawns. When the owner machine is gone entirely, Phase-1 behavior is **Rung 2 status-notice only** (no cross-machine resurrection until a distributed spawn lock exists — named re-evaluation trigger in §10 FD-4).
- **I5 — Honest messaging.** Rung 2 states the truth and never claims work is in progress when no session is alive (codex#5). Subject to `guardProxyOutput` + messaging-tone gates.
- **I6 — Idempotent spawn.** Durable `escalationAttemptId` persisted before spawn; epoch re-stamp is verified post-spawn; a partial failure cannot double-deliver (security#8, adversarial#1).
- **I7 — Quiet-hours + spend respected.** Rung 2/3 messaging re-checks quiet hours; any LLM use routes through the existing `LlmQueue` daily cap.
- **I8 — Untrusted commitment text (honest scope).** Injected promise text is fenced literal data, **treated as untrusted** — fencing *reduces* instruction-confusion but is not an absolute injection-proof barrier (LLM behavior can't be claimed perfectly contained). The structural side-effect gate (I13) is what *limits the impact*: even if injected text influences the revived session's reasoning/prose, no external mutation occurs before server-recorded revalidation. The guarantee is "impact-contained," not "influence-impossible."
- **I9 — GLOBAL escalation budget (thundering-herd brake).** Beyond per-commitment/per-topic limits, a **global semaphore** caps concurrent in-flight revives at `maxConcurrentEscalations` (default 2) and at most `maxEscalationSpawnsPerTick` (default 1) new spawns per beacon tick. Excess escalations fall back to Rung 2 / next tick. Under measured machine load/quota pressure (reuse the existing pressure signal the SessionReaper uses), Rung 1 is globally suppressed and only Rung 2 runs. This is the direct guard against the mass-reap thundering herd (scalability#1/#4) — the exact failure shape of the June-5 meltdown.
- **I10 — Secret-safe excerpts.** Rung 2/3 user text redacts secret-shaped content.
- **I11 — Field-level integrity.** `escalationAttempts`/`lastEscalationAt`/`currentRung`/`escalationAttemptId`/`escalationInFlight`/`revivalMode`/`revalidatedAt`/`revalidatedBy` are **server-written only** — never accepted on `POST`/`PATCH /commitments` (a caller cannot pre-set `escalationAttempts: 999` to disable the cap, nor PATCH `revalidatedAt` to self-clear the side-effect gate).
- **I12 — Rung-2 messaging is globally budgeted (no honest-spam flood).** Rung-2 sends after a mass reap are aggregated to one per-topic digest per `rung2DigestWindowMs` (§3.2). The honest-status path can never become its own flood — the symmetric messaging-side guard to I9.
- **I13 — Side-effects gated until revalidation (enforced, not prompted).** A revived session carries `revivalMode: status-only-until-revalidated`; the external-operation-gate blocks every non-read external operation for that session until it records an explicit revalidation (§3.0). Structural enforcement of the authority model — not reliance on prompt obedience.
- **I14 — Spawn idempotency at the SpawnRequestManager layer.** `escalationAttemptId` is the spawn idempotency key; duplicate spawn requests for one attempt are deduped at the spawn surface, not only by the beacon-side in-flight marker (I6).

## 5. Rollout (Graduated Feature Rollout track)

Ships **dark**, config-gated under `monitoring.promiseBeacon.escalation`:
- `enabled` (default `false` fleet; `true` for the dev agent per the dark-feature dogfood gate).
- `dryRun` (default `true`): logs *what it would escalate* (commitment, rung, refusal reason) to the audit without spawning or messaging. Dry-run evidence gates promotion.
- `maxEscalationAttempts` (3), `minEscalationIntervalMs` (default 120 000 — a hard floor, NOT caller-cadence-overridable, so an aggressive `cadenceMs` can't accelerate escalation), `maxConcurrentEscalations` (2), `maxEscalationSpawnsPerTick` (1), `reviveSettleMs` (30 000), `escalationGraceMs` (10 000), `rung2MinIntervalMs` (1 800 000), `rung2DigestWindowMs` (600 000), `rung2MaxNotifications` (4), `revalidationTtlMs` (1 800 000), `maxInjectFieldChars` (2000), `doubleSpawnDetectionWindowMs` (600 000), `doubleSpawnResetPeriodMs` (86 400 000).
- **Promotion criteria (quantified, FD-5):** dry-run → live on dev agent (Echo) after ≥ 1 week dry-run with the audit showing the ladder choosing correct rungs and zero would-be runaway (no commitment exceeding the cap in dry-run); live-dev → fleet after ≥ 2 weeks with ≥ 10 real revives, zero double-spawns, zero respawn-storm signatures, and operator sign-off (the fleet step is the operator's, never auto-flipped).

## 6. Observability

- Every escalation decision (rung, outcome, attempt count, **refusal reason** — quota/lease/unbound/budget, so a dropped revive is never silent — lessons#7) appends to `logs/promise-beacon-escalation.jsonl` (escalation decisions only, distinct from heartbeats).
- **Operator-facing counters (round 3, codex#6)** — the promotion criteria (§5) require *detecting* double-spawns and respawn storms, so the JSONL alone is insufficient. Expose aggregate counters at `GET /commitments/escalation-metrics`: attempts, refusals-by-reason, in-flight count, revive confirmations vs failures, Rung-2 digests sent, Rung-3 terminals, and a **double-spawn counter**.
- **Double-spawn counter governance (round 4 — increment / reset / alert defined).** *Increment:* when two distinct live session ids are observed bound to one commitment's topic with that commitment `escalationInFlight` within `doubleSpawnDetectionWindowMs` (default 600 000). *Reset:* rolls per `doubleSpawnResetPeriodMs` (default 86 400 000 / 1 day) so a single historical event doesn't block rollout forever, but the lifetime total is also retained for audit. *Alert:* any non-zero value raises ONE operator Attention item AND is the rollout's hard stop signal — live promotion is suspended until investigated. (Owner-return resets a commitment's Rung-2 notification count too: a `pending` commitment whose session is healthy again resumes normal heartbeats and its `escalationAttempts`/`rung2` counters clear.)
- `GET /commitments/:id` surfaces `escalationAttempts`, `lastEscalationAt`, `currentRung`, `revalidatedAt`, and last `refusalReason`. Legacy commitments normalize to `escalationAttempts: 0` on read (backward-compatible).
- **Metrics privacy/access (round 5, codex#4):** `/commitments/escalation-metrics` is Bearer-authed like all `/commitments/*` routes and returns **aggregate counters only** — no commitment excerpts, no user identifiers; where a per-commitment id is needed for correlation it is the opaque `CMT-NNNN` id already used elsewhere, not user/topic content. Counters retain per the reset periods above; raw escalation JSONL follows the existing log-retention policy.

## 7. Testing (all three tiers — Testing Integrity Standard)

- **Unit:** epoch-mismatch → Rung 1 attempted; spawn-refused → Rung 2 truthful message (no false "working"), quiet-hours-suppressed; budget exhausted → Rung 2 not Rung 1 (I9); N failures with exponential backoff → Rung 3 violated + ONE Attention item; idempotency — crash between spawn and re-stamp does not double-spawn (I6/I14); duplicate spawn request with same `escalationAttemptId` is a no-op at the spawn surface (I14); spawn-then-crash-before-settle clears `escalationInFlight` by the timeout contract and does NOT wedge the commitment (§3.1 deadlock test); attempt counter durable across simulated restart (I1); restart cannot re-raise the Rung-3 Attention item; ResumeQueue-owns-topic → beacon defers to Rung 2 (I2); standby/stale-replica loses CAS and never spawns (I4/§9); terminal/`paused` never escalate (I3); field-level write rejection incl. `revivalMode` (I11); secret redaction in excerpt (I10); malicious injected commitment text → the external-operation-gate REJECTS the attempted side-effecting tool call (test asserts gate enforcement, not model compliance — round 4, codex#5/I8); a revived `revivalMode` session is blocked from side-effecting tools until server-recorded revalidation, and cannot self-clear `revalidatedAt` (I13/I11); mass-reap → Rung-2 sends collapse to one per-topic digest (I12).
- **Integration:** `/commitments/:id` exposes escalation fields; the dry-run path logs intent with no spawn/message side effects.
- **E2E lifecycle:** a beacon-eligible commitment whose bound session is killed is revived into a fresh session (feature live), or — in dry-run — produces an audit entry and no spawn. The "feature is alive" assertion: the escalation wiring is non-null and reachable from server boot (deps not no-op). Plus a **report-only E2E** (round 5, codex#5): an owner-gone commitment where revival can only *report status*, never complete the work, ends with the user receiving the `owner-gone` template and the commitment surfaced to Attention — not a false completion.
- **Conversation-quality golden tests (round 5, codex#5):** snapshot-test each Rung-2/Rung-3 template (`retryable`/`owner-gone`/`quota-limited`/`operator-needed`) and the per-topic digest wording, so a future edit can't silently regress a truthful message into a misleading one.

## 7a. Foundation prerequisites (named, not assumed)

The spec extends two existing subsystems and depends on three foundation capabilities — named explicitly so the build phase can verify/add them rather than discovering a gap mid-implementation (round 3 foundation audit):
- **`CommitmentTracker.mutate()` CAS** — already the surface all commitment state uses; escalation fields ride it. No new primitive.
- **`SpawnRequestManager` idempotency key** — the spawn surface must accept `escalationAttemptId` and treat a duplicate request with the same key (within a window, default 1h) as a no-op (I14). If the current surface lacks this, adding it is an in-scope prerequisite of this build, built here rather than split out.
- **Lease/owner store CAS for spawn authority** (§9) — escalation spawns gate on the topic's fenced lease epoch; this is the existing multi-machine lease, reused.
- **external-operation-gate** — the existing `mcp__*` PreToolUse gate (`/operations/evaluate`) must read the session's `revivalMode` and the commitment's `revalidatedAt` to enforce I13. The gate exists today; this build adds the `revivalMode`-aware branch to it (in-scope, built here).

## 8. Migration parity

- **ConfigDefaults** gains the `monitoring.promiseBeacon.escalation` block (all fields in §5) with the dark defaults.
- **`migrateConfig()`** backfills the block on existing agents, existence-checked + idempotent (only adds missing fields). Tested by the migration suite.
- **Commitment data model** gains optional cold-state fields (`escalationAttempts?`, `lastEscalationAt?`, `currentRung?`, `escalationAttemptId?`, `escalationInFlight?`) — optional so pre-existing commitments and tests are unaffected; `record()` initializes `escalationAttempts: 0`.
- **CLAUDE.md template** (Agent Awareness): a Capabilities note that promises now self-revive on session death (Rung 1) or get an honest interim status (Rung 2), and that `/commitments/:id` exposes the escalation fields.

## 9. Multi-machine posture (mandatory declaration)

- **Escalation execution:** owner-machine-local BY DESIGN in Phase 1 (I4) — only the topic's lease-holder escalates; no cross-machine resurrection until a distributed spawn lock exists (FD-4 re-eval trigger).
- **Escalation counters / in-flight marker:** carried on the Commitment record → **replicated** via the same CommitmentTracker path the rest of commitment state uses. Consistency under failover: escalation spawn-authority is gated on a CAS that linearizes through the topic's **fenced lease/owner store** (the same lease that decides which machine serves the topic), not merely a local-replica version bump — a standby that does not hold the current lease epoch fails the CAS and does not spawn. The **spawn idempotency key (I14) is scoped to the commitment-attempt lifecycle, not a short fixed TTL** (round 4, codex#4): the key is `commitmentId:escalationAttemptId` and is retained until the commitment reaches a terminal state, so a duplicate spawn for the *same* attempt is deduped even long after.
- **Honest partition residual (Phase-1, NOT over-claimed — round 4).** A partition + weak-replication window could let two machines write *different* `escalationAttemptId`s for one commitment; since each is a distinct attempt, idempotency (which dedups *within* an attempt) would NOT prevent both from spawning — so **two sessions could briefly exist**. This is the documented Phase-1 boundary (it disappears when the distributed spawn lock of FD-4 lands). It is *detected AND auto-reconciled*, not silently tolerated:
  - **Per-topic live-session reconciliation (round 5, codex#3 — bounds the blast radius).** A topic is a single-session resource by invariant. A reconciliation pass (reusing the existing post-transfer/reaper closeout that already enforces "one session per topic") asserts: if more than one live session is ever observed for a topic, **all but the current lease-holder's session are forced to `revivalMode: status-only` and then closed** — so even under repeated partitions + retry backoff, the steady state converges to one session, never N. The blast radius is provably "at most one extra session, transiently," not an unbounded count.
  - The **double-spawn counter (§6) is the detection + rollout-stop mechanism**; the reconciliation rule is the auto-correction. The spec does not claim I14 alone *prevents* a partition double-session — it claims the residual is detected, auto-reconciled to one, and bounded by the I9 global budget.
- **Rung-3 Attention item:** routed through the existing aggregated Attention surface (its own replication/dedup); dedup key = commitment id, raised once per lifetime.
- **Audit JSONL:** machine-local record of that machine's own escalation decisions (per-machine, like other monitoring audits); not a shared-state source of truth.

## 10. Frontloaded Decisions

- **FD-1 — Authority model (NON-cheap; frontloaded, not punted).** v1 escalation confers no new authority; Rung 1 revives a normal gated session with a conservative status-first prompt; no separate per-commitment auto-execute gate in v1 (relies on existing operation/coherence gates + dark/dry-run). See §3.0. Re-eval trigger: if a class of actionful promises proves to need pre-execution confirmation in practice, add an `actionClass` field + gate in v2.
- **FD-2 — Defaults.** `maxEscalationAttempts=3`, `minEscalationIntervalMs=120000` (hard floor), `maxConcurrentEscalations=2`, `maxEscalationSpawnsPerTick=1`, `reviveSettleMs=30000`, `rung2MinIntervalMs=1800000`. Cheap-to-change-after (config knobs, no external/identity surface; ships dark) — contested and cleared.
- **FD-3 — Attempt-counter semantics.** Only Rung-1 spawn attempts consume `maxEscalationAttempts`; Rung-2 messaging is separately rate-limited and never consumes the cap. See §3.2/§4 I1.
- **FD-4 — Phase-1 owner-gone behavior.** Status-notice only (no cross-machine resurrection). Re-eval trigger: a distributed spawn lock / session-pool transfer lands.
- **FD-5 — Promotion criteria.** Quantified in §5; the fleet step requires operator sign-off and is never auto-flipped.

## 11. Open questions

*(none)*
