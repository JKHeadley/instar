# Promise-Beacon Escalation — a promise survives its owning session's death

**Status:** draft (pre-convergence)
**Issue:** JKHeadley/instar#1093
**Constitutional anchor:** *Close the Loop* (`docs/STANDARDS-REGISTRY.md`) — "Every loop the agent opens — a promise to a user — must be durably registered and re-surfaced on a cadence until it reaches a *deliberate* close." Today a promise whose owning session dies is silently terminalized (`violated: session-lost`); this spec adds the missing rung that re-surfaces it *into action*, not just into a postmortem record.

---

## 1. The incident this fixes (live, 2026-06-12)

Echo promised Justin a dashboard link "the moment it's live" and registered it durably as **CMT-1419** (one-time-action, beacon-eligible) at ~14:26 PDT. The owning session went silent ~14:40 PDT. The commitment sat **open in the registry for ~3.5 hours** while the user heard nothing actionable. At 17:52 Justin: *"You made it sound like you would get back to me but you never did."*

The registry did its job — a new session could reconstruct exactly what was promised. What failed is the **follow-through arm**: nothing converted *open commitment + dead owning session* into either (a) a fresh agent turn that actually does the promised work, or (b) an honest interim status to the user.

## 2. Current behavior (verified in source, v1.3.506)

`PromiseBeacon.fire()` (`src/monitoring/PromiseBeacon.ts`):

- **Session-epoch check** (lines ~384–392): if the commitment's stamped `sessionEpoch` differs from the live epoch of the session currently bound to its `topicId`, it calls `transitionViolated(c, 'session-lost')` and returns.
- **`transitionViolated`** (lines ~586–600): sets `status: 'violated'`, sends a one-shot `⚠️ commitment "…" violated: session-lost` message, then `stopFor(id)` — **terminal**. Because `fire()` early-returns on `status !== 'pending'`, every subsequent heartbeat is a no-op.
- **When `getSessionForTopic(topicId)` returns `null`** (session fully gone, not merely re-epoched): the epoch block is *skipped entirely*; the beacon proceeds, captures no snapshot, and emits a generic templated "still working" heartbeat — a **misleading** signal, since nothing is working, and still **no work happens**.

Net: the promise is either silently tombstoned or papered over with a false "still working" — never escalated into a turn that fulfills it.

## 3. Design — the escalation rung

When `fire()` detects the owning session is **gone or re-epoched** for a *pending, beacon-eligible* commitment, do NOT terminalize. Instead run a bounded escalation ladder:

### Rung 1 — Revive-and-inject (preferred)
Re-deliver the commitment into a **fresh live session bound to the commitment's `topicId`**, so an agent turn actually happens and can fulfill the promise.
- Reuse the existing spawn/inject path (the same one the mid-work ResumeQueue and the Telegram bridge use); do **not** invent a second spawn primitive.
- The injected prompt is a CONTINUATION carrying the commitment's `userRequest` + `agentResponse` (what was promised) + an explicit "your prior session ended before delivering this; pick it up or report honest status" instruction.
- After a successful inject, **re-stamp** the commitment's `sessionEpoch` to the new session and keep it `pending`. The promise is now owned by a live session again.

### Rung 2 — Honest interim status (fallback)
If Rung 1 cannot run (spawn refused: at session cap, quota pressure, machine not lease-holder, topic not bound, or escalation disabled), send the user a **truthful** message via the existing `sendMessage` path:
> "Still on *<promise excerpt>* — my session ended before I delivered it. I'll pick it back up shortly." (templated; no LLM call required)
Then leave the commitment `pending` and `atRisk` so it keeps surfacing — never a false "working" snapshot.

### Rung 3 — Bounded give-up (terminal, loud)
Only after the escalation ladder fails **N consecutive times** (config `maxEscalationAttempts`, default 3) across the cadence window does the commitment transition to `violated: session-lost-unrecovered`, AND a single deduped **Attention-queue** item is raised so the operator sees a promise that genuinely could not be kept. This preserves the postmortem value of today's behavior while removing the silent-death failure mode.

## 4. Safety invariants (the bug classes this must NOT reintroduce)

These mirror the No-Unbounded-Loops standard ratified 2026-06-05 — the escalation ladder is itself a loop and gets the same brakes:

- **I1 — No respawn storm.** Per-commitment escalation is rate-limited (min interval between escalation attempts, default ≥ the beacon's min cadence) AND capped at `maxEscalationAttempts` total. A flapping session cannot trigger unbounded respawns.
- **I2 — Single-flight per topic.** At most one in-flight revive-inject per `topicId` at a time. Reuse the existing proxy/spawn coordinator lock so escalation cannot race the ResumeQueue or the Telegram bridge into a double-spawn for the same topic.
- **I3 — No double-fulfillment.** Re-stamping `sessionEpoch` on a successful inject means the *next* tick sees a matching epoch and resumes normal heartbeats — it must not immediately re-escalate. The injected session, on delivering, marks the commitment `delivered` through the normal path.
- **I4 — Lease-gated.** On a multi-machine deployment, only the lease-holder for the topic may escalate (reuse the existing `speakerElection` / ownerMachineId gate already in `fire()`). A standby never spawns.
- **I5 — Honest messaging.** The fallback message states the truth (session ended, picking back up); it never claims work is in progress when no session is alive. Subject to the existing `guardProxyOutput` + messaging-tone gates.
- **I6 — Quiet hours & spend cap respected.** Escalation obeys the existing quiet-hours suppression and LlmQueue daily spend cap (Rung 1's inject is a spawn, not an LLM-queue call, but Rung 2/3 messaging and any status generation route through the existing caps).
- **I7 — Terminal states never escalate.** Only `pending` commitments escalate; `delivered`/`expired`/`cancelled` are untouched.

## 5. Rollout (Graduated Feature Rollout track)

Ships **dark**, config-gated under `monitoring.promiseBeacon.escalation`:
- `enabled` (default `false` at fleet; default `true` for the dev agent per the dark-feature dogfood gate).
- `dryRun` (default `true`): logs *what it would escalate* (which commitment, which rung) to the beacon audit without spawning or messaging. The dry-run evidence is what gates promotion.
- `maxEscalationAttempts` (default 3), `minEscalationIntervalMs` (default = beacon min cadence).
- Promotion ladder: dry-run on dev agent → live on dev agent (Echo) → fleet, each step gated on audit evidence (escalations attempted, successful revives, fallback messages, give-ups) and a clean soak.

## 6. Observability

- Every escalation decision (rung chosen, outcome, attempt count) appends to a beacon escalation audit (`logs/promise-beacon-escalation.jsonl` or the existing beacon audit stream).
- `GET /commitments/:id` surfaces `escalationAttempts`, `lastEscalationAt`, and the current rung.
- The give-up Attention item (Rung 3) is deduped per commitment.

## 7. Testing (all three tiers — Testing Integrity Standard)

- **Unit:** epoch-mismatch → Rung 1 attempted; spawn-refused → Rung 2 message (truthful, no false "working"); N failures → Rung 3 violated + one Attention item; re-stamp prevents immediate re-escalation (I3); rate-limit caps attempts (I1); terminal states never escalate (I7); lease gate blocks standby escalation (I4).
- **Integration:** `/commitments/:id` exposes escalation fields; the dry-run path logs intent without side effects.
- **E2E lifecycle:** a beacon-eligible commitment whose bound session is killed gets revived into a fresh session (feature live), or — in dry-run — produces an audit entry and no spawn. The "feature is alive" assertion: the escalation wiring is non-null and reachable from server boot.

## 8. Migration parity

- `migrateConfig()` adds `monitoring.promiseBeacon.escalation` defaults (existence-checked).
- No hook/skill/CLAUDE.md-template surface beyond the Agent Awareness addition (a Capabilities note that promises now self-revive, + the `escalationAttempts` field on `/commitments/:id`).

## 9. Open questions

*(none)*
