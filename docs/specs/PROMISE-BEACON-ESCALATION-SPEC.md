---
title: "Promise-Beacon Escalation — a promise survives its owning session's death"
slug: "promise-beacon-escalation"
author: "echo"
eli16-overview: "docs/specs/promise-beacon-escalation.eli16.md"
---

# Promise-Beacon Escalation — a promise survives its owning session's death

**Status:** draft (convergence rounds 1–2 applied)
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
- **Status-first is ENFORCED STATE, not a prompt wish** (Structure > Willpower — round 2, codex#4). A revived session is spawned carrying a machine-readable **`revivalMode: status-only-until-revalidated`** marker (passed at spawn, written to the session's durable record). The external-operation-gate reads this marker and **blocks every side-effecting tool** (`mcp__*` writes, git push, deploys, any non-read external operation) until the session performs an explicit **revalidation step** — a recorded acknowledgement that it has re-established current context and the promised action is still correct. Until then the session can only read, reason, and *report*. The conservative injected prompt (below) explains this to the session, but the guarantee is the gate, not the prose: even a misbehaving revived turn cannot mutate external state before revalidating.
- **The injected prompt** (the human-readable half) instructs the revived session to (a) re-establish what was promised, (b) send the user an **honest status**, (c) treat the original promise as **possibly stale** (ephemeral workspace state — in-flight tool results, dev-server ports, auth/unstaged files — may be gone; verify prerequisites before acting, codex#2), and (d) revalidate explicitly before any side-effecting step.
- **v1 scope is "re-engage and report," not "auto-complete arbitrary work."** This is a **Frontloaded Decision** (§10, FD-1): v1 deliberately does not add a separate per-commitment "may auto-execute?" gate — instead the `revivalMode` gate above structurally holds side-effects until revalidation, layered on the per-action gates the agent already enforces. It is frontloaded here precisely because it touches autonomous external side-effects — never "cheap-to-change-after."

### 3.1 Rung 1 — Revive-and-inject (preferred, status-first)
Re-deliver the commitment into a **fresh live session bound to the commitment's `topicId`** so an agent turn happens.
- **Reuse the existing spawn/inject path** — `SpawnRequestManager` (the same surface the mid-work ResumeQueue and Telegram bridge use). No second spawn primitive.
- **Injected CONTINUATION payload (concrete shape — I8).** Delivered as a single structured block: a fixed natural-language instruction (the §3.0 conservative prompt), then the commitment data as a **fenced, JSON-serialized, separately-labelled `data` block** — `commitmentId`, `userRequest`, `agentResponse`, `escalationAttemptId`, `revivalMode` — each string field length-capped (`maxInjectFieldChars`, default 2000) and truncated with an explicit `…[truncated]` marker. The promise text is presented as DATA the session is summarizing, never as instructions to obey; the natural-language half and the data half are visually and structurally separated so a directive embedded in `userRequest` reads as quoted content, not a command. The session reconstructs remaining context from its own thread history.
- **Idempotency (I6) — enforced at the spawn surface, not just beacon-side.** BEFORE the spawn, durably persist `escalationAttemptId` (uuid) + `lastEscalationAt` + increment `escalationAttempts` via `CommitmentTracker.mutate()` (CAS), and set `escalationInFlight`. The spawn request to `SpawnRequestManager` carries `escalationAttemptId` as an **idempotency key**: a second spawn request with the same key is a no-op at the spawn layer (deduped there), so even a beacon-side marker loss or a process crash between persist and spawn cannot produce two live sessions for one attempt. The in-flight marker is resolved deterministically by the timeout contract above (never an open-ended wait).
- **Revive-confirmation is owned by `fire()`, on a deterministic timeout — never an open-ended wait** (closes the spawn-then-crash deadlock, round 2). The escalating tick does NOT block waiting for the revive. It sets `escalationInFlight` + `lastEscalationAt` and returns. On each subsequent tick, for a commitment with `escalationInFlight: true`, `fire()` resolves the in-flight escalation deterministically:
  - **Confirmed** — a live session is bound to the topic, its epoch differs from the (now stale) stamped one, and it has been alive ≥ `reviveSettleMs` (default 30s): re-stamp `sessionEpoch` to the new session, keep `status: 'pending'`, clear `escalationInFlight` + `currentRung`. Normal heartbeats resume.
  - **Failed** — `now − lastEscalationAt > reviveSettleMs + escalationGraceMs` (grace default 10s) with no confirmed live session (spawn refused silently, or session came up and died before settling): the attempt has already been counted (incremented before spawn, I1), so just **clear `escalationInFlight`**. The next eligible tick re-evaluates under the I1 backoff + cap — Rung 1 retry if under cap, else Rung 2/3. The in-flight flag can therefore never wedge a commitment permanently.

### 3.2 Rung 2 — Honest interim status (fallback)
If Rung 1 cannot run — spawn refused (session cap, quota pressure, not owner machine, topic unbound, escalation disabled) OR the global concurrency budget (§4 I9) is exhausted this tick — send the user a **truthful, condition-specific** templated message (no LLM call):
> "Still on *<redacted promise excerpt>* — my session ended before I delivered it and I can't resume automatically right now. This is still open; I'll pick it up as soon as I can." (when resumption is genuinely blocked, the wording says so — it never claims "working" or a false "shortly".)
- **Secret-safe excerpt (I10):** the excerpt is redacted (drops tokens/keys/`secret`/`password` patterns); if the remainder is unsafe, a generic "an action I promised you" is used.
- Leaves the commitment `pending` + `atRisk`. **Rung 2 messaging does NOT consume the Rung-1 attempt cap** (§4 I1) — it is separately rate-limited per commitment (at most one Rung-2 message per `rung2MinIntervalMs`, default 30 min, de-duplicated by content) AND **globally/per-topic budgeted (I12)**: after a mass reap many commitments can hit Rung 2 at once, so Rung-2 sends are aggregated into **one digest per topic per `rung2DigestWindowMs`** ("3 things I owe you are paused because my sessions ended — …") rather than N separate messages. This is the messaging-side analogue of the Rung-1 thundering-herd brake (I9): neither rung can flood after a mass session death.
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
- **I2 — Single-flight per topic, coordinated with ResumeQueue.** At most one in-flight revive per `topicId`, via the shared `SpawnRequestManager`/proxy coordinator key `promise-escalation:<topicId>`. **ResumeQueue owns mid-work session revival**; before Rung 1 spawns, the beacon checks whether the topic already has a live/queued ResumeQueue entry — if so it **defers to Rung 2** (no double-spawn). Spec-level ownership rule, not hand-waved.
- **I3 — Only `pending` non-paused commitments escalate.** Terminal + `paused` states are untouched.
- **I4 — Owner-machine scoped (Phase-1 honest posture).** Escalation runs ONLY on the machine that holds the topic (the `speakerElection.decide()` / `ownerMachineId` gate, **re-checked immediately before the spawn**, not just at `fire()` entry — closes the elect-then-spawn race). A standby NEVER spawns. When the owner machine is gone entirely, Phase-1 behavior is **Rung 2 status-notice only** (no cross-machine resurrection until a distributed spawn lock exists — named re-evaluation trigger in §10 FD-4).
- **I5 — Honest messaging.** Rung 2 states the truth and never claims work is in progress when no session is alive (codex#5). Subject to `guardProxyOutput` + messaging-tone gates.
- **I6 — Idempotent spawn.** Durable `escalationAttemptId` persisted before spawn; epoch re-stamp is verified post-spawn; a partial failure cannot double-deliver (security#8, adversarial#1).
- **I7 — Quiet-hours + spend respected.** Rung 2/3 messaging re-checks quiet hours; any LLM use routes through the existing `LlmQueue` daily cap.
- **I8 — Untrusted commitment text.** Injected promise text is fenced literal data; cannot inject instructions into the revived session (prompt-injection hardening).
- **I9 — GLOBAL escalation budget (thundering-herd brake).** Beyond per-commitment/per-topic limits, a **global semaphore** caps concurrent in-flight revives at `maxConcurrentEscalations` (default 2) and at most `maxEscalationSpawnsPerTick` (default 1) new spawns per beacon tick. Excess escalations defer to Rung 2 / next tick. Under measured machine load/quota pressure (reuse the existing pressure signal the SessionReaper uses), Rung 1 is globally suppressed and only Rung 2 runs. This is the direct guard against the mass-reap thundering herd (scalability#1/#4) — the exact failure shape of the June-5 meltdown.
- **I10 — Secret-safe excerpts.** Rung 2/3 user text redacts secret-shaped content.
- **I11 — Field-level integrity.** `escalationAttempts`/`lastEscalationAt`/`currentRung`/`escalationAttemptId`/`escalationInFlight`/`revivalMode` are **server-written only** — never accepted on `POST`/`PATCH /commitments` (a caller cannot pre-set `escalationAttempts: 999` to disable the cap).
- **I12 — Rung-2 messaging is globally budgeted (no honest-spam flood).** Rung-2 sends after a mass reap are aggregated to one per-topic digest per `rung2DigestWindowMs` (§3.2). The honest-status path can never become its own flood — the symmetric messaging-side guard to I9.
- **I13 — Side-effects gated until revalidation (enforced, not prompted).** A revived session carries `revivalMode: status-only-until-revalidated`; the external-operation-gate blocks every non-read external operation for that session until it records an explicit revalidation (§3.0). Structural enforcement of the authority model — not reliance on prompt obedience.
- **I14 — Spawn idempotency at the SpawnRequestManager layer.** `escalationAttemptId` is the spawn idempotency key; duplicate spawn requests for one attempt are deduped at the spawn surface, not only by the beacon-side in-flight marker (I6).

## 5. Rollout (Graduated Feature Rollout track)

Ships **dark**, config-gated under `monitoring.promiseBeacon.escalation`:
- `enabled` (default `false` fleet; `true` for the dev agent per the dark-feature dogfood gate).
- `dryRun` (default `true`): logs *what it would escalate* (commitment, rung, refusal reason) to the audit without spawning or messaging. Dry-run evidence gates promotion.
- `maxEscalationAttempts` (3), `minEscalationIntervalMs` (default 120 000 — a hard floor, NOT caller-cadence-overridable, so an aggressive `cadenceMs` can't accelerate escalation), `maxConcurrentEscalations` (2), `maxEscalationSpawnsPerTick` (1), `reviveSettleMs` (30 000), `escalationGraceMs` (10 000), `rung2MinIntervalMs` (1 800 000), `rung2DigestWindowMs` (600 000), `maxInjectFieldChars` (2000).
- **Promotion criteria (quantified, FD-5):** dry-run → live on dev agent (Echo) after ≥ 1 week dry-run with the audit showing the ladder choosing correct rungs and zero would-be runaway (no commitment exceeding the cap in dry-run); live-dev → fleet after ≥ 2 weeks with ≥ 10 real revives, zero double-spawns, zero respawn-storm signatures, and operator sign-off (the fleet step is the operator's, never auto-flipped).

## 6. Observability

- Every escalation decision (rung, outcome, attempt count, **refusal reason** — quota/lease/unbound/budget, so a dropped revive is never silent — lessons#7) appends to `logs/promise-beacon-escalation.jsonl` (escalation decisions only, distinct from heartbeats).
- `GET /commitments/:id` surfaces `escalationAttempts`, `lastEscalationAt`, `currentRung`, and last `refusalReason`. Legacy commitments normalize to `escalationAttempts: 0` on read (backward-compatible).

## 7. Testing (all three tiers — Testing Integrity Standard)

- **Unit:** epoch-mismatch → Rung 1 attempted; spawn-refused → Rung 2 truthful message (no false "working"), quiet-hours-suppressed; budget exhausted → Rung 2 not Rung 1 (I9); N failures with exponential backoff → Rung 3 violated + ONE Attention item; idempotency — crash between spawn and re-stamp does not double-spawn (I6/I14); duplicate spawn request with same `escalationAttemptId` is a no-op at the spawn surface (I14); spawn-then-crash-before-settle clears `escalationInFlight` by the timeout contract and does NOT wedge the commitment (§3.1 deadlock test); attempt counter durable across simulated restart (I1); restart cannot re-raise the Rung-3 Attention item; ResumeQueue-owns-topic → beacon defers to Rung 2 (I2); standby/stale-replica loses CAS and never spawns (I4/§9); terminal/`paused` never escalate (I3); field-level write rejection incl. `revivalMode` (I11); secret redaction in excerpt (I10); injected commitment text is data-fenced and cannot inject instructions (I8); a revived `revivalMode` session is blocked from side-effecting tools until it records revalidation (I13); mass-reap → Rung-2 sends collapse to one per-topic digest (I12).
- **Integration:** `/commitments/:id` exposes escalation fields; the dry-run path logs intent with no spawn/message side effects.
- **E2E lifecycle:** a beacon-eligible commitment whose bound session is killed is revived into a fresh session (feature live), or — in dry-run — produces an audit entry and no spawn. The "feature is alive" assertion: the escalation wiring is non-null and reachable from server boot (deps not no-op).

## 8. Migration parity

- **ConfigDefaults** gains the `monitoring.promiseBeacon.escalation` block (all fields in §5) with the dark defaults.
- **`migrateConfig()`** backfills the block on existing agents, existence-checked + idempotent (only adds missing fields). Tested by the migration suite.
- **Commitment data model** gains optional cold-state fields (`escalationAttempts?`, `lastEscalationAt?`, `currentRung?`, `escalationAttemptId?`, `escalationInFlight?`) — optional so pre-existing commitments and tests are unaffected; `record()` initializes `escalationAttempts: 0`.
- **CLAUDE.md template** (Agent Awareness): a Capabilities note that promises now self-revive on session death (Rung 1) or get an honest interim status (Rung 2), and that `/commitments/:id` exposes the escalation fields.

## 9. Multi-machine posture (mandatory declaration)

- **Escalation execution:** owner-machine-local BY DESIGN in Phase 1 (I4) — only the topic's lease-holder escalates; no cross-machine resurrection until a distributed spawn lock exists (FD-4 re-eval trigger).
- **Escalation counters / in-flight marker:** carried on the Commitment record → **replicated** via the same CommitmentTracker path the rest of commitment state uses. Consistency under failover (round 2, codex#6): only the owner machine writes (I4), and every escalation mutation is a **CAS/version-checked** `mutate()` against the local record — a stale replica that briefly believes it is owner during a failover loses the CAS (its version is behind) and does not spawn. The combination (owner-only-writes + CAS-before-spawn + the I14 spawn idempotency key) is what makes a replication-lag double-spawn non-viable; the spec does NOT assume strong/synchronous replication.
- **Rung-3 Attention item:** routed through the existing aggregated Attention surface (its own replication/dedup); dedup key = commitment id, raised once per lifetime.
- **Audit JSONL:** machine-local record of that machine's own escalation decisions (per-machine, like other monitoring audits); not a shared-state source of truth.

## 10. Frontloaded Decisions

- **FD-1 — Authority model (NON-cheap; frontloaded, not deferred).** v1 escalation confers no new authority; Rung 1 revives a normal gated session with a conservative status-first prompt; no separate per-commitment auto-execute gate in v1 (relies on existing operation/coherence gates + dark/dry-run). See §3.0. Re-eval trigger: if a class of actionful promises proves to need pre-execution confirmation in practice, add an `actionClass` field + gate in v2.
- **FD-2 — Defaults.** `maxEscalationAttempts=3`, `minEscalationIntervalMs=120000` (hard floor), `maxConcurrentEscalations=2`, `maxEscalationSpawnsPerTick=1`, `reviveSettleMs=30000`, `rung2MinIntervalMs=1800000`. Cheap-to-change-after (config knobs, no external/identity surface; ships dark) — contested and cleared.
- **FD-3 — Attempt-counter semantics.** Only Rung-1 spawn attempts consume `maxEscalationAttempts`; Rung-2 messaging is separately rate-limited and never consumes the cap. See §3.2/§4 I1.
- **FD-4 — Phase-1 owner-gone behavior.** Status-notice only (no cross-machine resurrection). Re-eval trigger: a distributed spawn lock / session-pool transfer lands.
- **FD-5 — Promotion criteria.** Quantified in §5; the fleet step requires operator sign-off and is never auto-flipped.

## 11. Open questions

*(none)*
