# Side-Effects Review — Promise-Beacon Escalation

**Version / slug:** `promise-beacon-escalation`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `required` (touches sentinel / gate / session-lifecycle / recovery)
**Spec:** `docs/specs/PROMISE-BEACON-ESCALATION-SPEC.md` (converged + approved) · **Issue:** JKHeadley/instar#1093

## Summary of the change

When a beacon-enabled commitment's owning session dies before delivering, the
PromiseBeacon no longer silently terminalizes it to `violated: session-lost`.
Instead it escalates: **Rung 1** revives a fresh, fully-gated session bound to the
topic (carrying a conservative status-first continuation + the promise as fenced
untrusted data); **Rung 2** sends an honest, recoverability-state-specific interim
status when it can't revive; **Rung 3** is a bounded loud give-up to the operator
Attention queue. A revived session is held `revivalMode: status-only-until-revalidated`
— every non-read external operation is BLOCKED at `/operations/evaluate` until the
session records a server-side revalidation (`POST /commitments/:id/revalidate`), so
escalation confers no new authority. Ships **dark + dry-run-first** behind
`monitoring.promiseBeacon.escalation` (developmentAgent-gated `enabled`).

Files: `PromiseBeacon.ts` (ladder), `CommitmentTracker.ts` (durable server-only
escalation fields), `server.ts` (requestRevive via `spawnSessionForTopic` +
raiseAttention + config wiring), `routes.ts` (revalidate + escalation-metrics + I13
gate pre-check), `PostUpdateMigrator.ts` (hook now sends `sessionName` for I13),
`ConfigDefaults.ts` (dark defaults), `templates.ts` (agent-awareness). Tests: 11
unit + 7 integration + 3 e2e.

## Decision-point inventory

- **Rung-selection** (revive / honest-status / give-up): a decision over the
  agent's own follow-through. Bounded by backoff + cap + global budget (No
  Unbounded Loops). Not a message/dispatch block — it acts on the agent's own
  commitments only.
- **I13 revivalMode side-effect gate**: a BLOCK on external operations. This is
  the one new blocking authority — analysed in §4.

## 1. Over-block

The I13 gate blocks a session's *non-read external operations* only when (a) the
caller passes `sessionName`, (b) that session's bound topic has an ACTIVE commitment
in `revivalMode`, and (c) it has not recorded a fresh matching revalidation. A
legitimate non-revived session is never over-blocked: it has no revivalMode
commitment on its topic, so the lookup is a fast negative. A revived session that
*should* act is one `POST …/revalidate` away (a deliberate re-think step, per
spec §3.0). Reads are never gated (the hook fast-paths reads before the server call).
Residual: a normal session sharing a topic with a revivalMode commitment would also
be held — but by the single-session-per-topic invariant the revived session IS that
session, so this is the intended target, not collateral.

## 2. Under-block

Promises that never become *registered* commitments are invisible to this net (the
deeper gap named in CMT-1433 — out of scope here, the beacon only sees registered
beacon-enabled commitments). The I13 gate keys on session→topic→commitment; a
side-effecting tool call that does NOT route through the `mcp__*` external-operation
hook (e.g. a raw shell `git push`) is not caught by I13 — but those already have
their own gates (dangerous-command-guard, coherence gate), and the strong barrier
remains the per-action gates every session passes (spec §3.0 states this honestly:
revalidation is a speed-bump, not a semantic safety oracle).

## 3. Level-of-abstraction fit

Right layers. The ladder lives in PromiseBeacon (which already owns the
session-epoch loss detection it replaces). Revive reuses `spawnSessionForTopic` —
the same primitive the ResumeQueue drainer uses — no second spawn primitive. The
I13 gate is a thin pre-check in the existing `/operations/evaluate` route (reusing
the session→topic resolver and commitmentTracker already on `ctx`), NOT a change to
`ExternalOperationGate`'s core class — keeping the hot path untouched for normal
sessions. revivalMode lives on the commitment (the durable record), not a parallel
store.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The beacon remains a signal-producer for rung selection (it acts only on the
agent's own commitments, never seizing authority over external state). The ONE new
blocking authority — the I13 gate — is deliberate and is the *opposite* of a
brittle-check-with-authority: it is a coarse, deterministic, structural hold
(`revivalMode` set ⇒ block non-read until server-recorded revalidation). It adds NO
new permission and cannot let a revived session do anything a normal session
couldn't; it only *delays* until one explicit re-think. The revalidation fields are
server-written-only (I11) so a session cannot self-clear the gate. This is
Structure-over-Willpower: the status-first contract is enforced by the gate, not by
prompt obedience.

## 5. Interactions

- **ResumeQueue**: before Rung-1 spawn, the beacon defers to Rung 2 if the
  ResumeQueue already holds a live/queued entry for the topic (`resumeQueuedForSession`)
  — the two cannot double-spawn one topic.
- **Single-session-per-topic reaper closeout**: the existing post-transfer/reaper
  "one session per topic" invariant bounds any partition double-session to "at most
  one extra, transiently" (spec §9).
- **Legacy path preserved**: with escalation OFF (fleet default), `fire()` takes the
  exact prior `transitionViolated(c, 'session-lost')` branch — byte-for-byte
  unchanged behavior (test asserts this).
- **Quiet hours / daily-spend cap**: the existing top-level `fire()` guards
  short-circuit before escalation, so escalation respects them automatically.
- **I13 hook field**: `external-operation-gate.js` now sends `sessionName`
  (`INSTAR_SESSION_NAME`, already injected via tmux `-e`). A server that doesn't
  understand the field ignores it; a hook that omits it (older install) simply gets
  no I13 enforcement — fail-open, never fail-closed.

## 6. External surfaces

Two new authed routes (`POST /commitments/:id/revalidate`, `GET /commitments/escalation-metrics`).
escalation-metrics returns aggregate counters only — no excerpts, no user/topic
content (spec §6 privacy). Rung-2 messages are user-facing Telegram sends: they are
honest by construction (one approved template per recoverability state; golden tests
snapshot the wording so a future edit can't silently make a truthful message
misleading), secret-redacted, quiet-hours-gated, per-commitment-floored, and
Rung-3-capped against honest-spam. The CLAUDE.md template gains an awareness note.
Migration backfills the dark config block to existing agents; the hook is
always-overwritten so existing agents get the `sessionName` field.

## 7. Multi-machine posture (Cross-Machine Coherence)

Declared in spec §9. **Escalation execution: machine-local BY DESIGN (Phase 1)** —
only the topic's lease-holder escalates (`speakerElection.decide` re-checked
immediately before spawn; a standby never spawns). **Escalation counters /
revivalMode / revalidatedAt: replicated** — they ride the Commitment record through
the same CommitmentTracker replication path as the rest of commitment state.
**Honest partition residual:** a partition + weak-replication window could let two
machines mint different `escalationAttemptId`s and briefly spawn two sessions. The
**detection arm is wired**: `resolveInFlight` checks `liveSessionCountForTopic` each
in-flight tick and, when it observes >1 live session for the topic, increments the
`doubleSpawnCount` counter once per attempt (surfaced at
`/commitments/escalation-metrics`) — any non-zero value is the rollout hard-stop
signal (spec §6). The **auto-correction arm** is the existing reaper /
post-transfer single-session-per-topic closeout (a separate, already-shipped
system), which converges to "at most one extra, transiently," bounded by the I9
global budget. The beacon does not itself re-close sessions — it detects and
signals; the closeout corrects. Not over-claimed as prevented. User-facing Rung-2 sends go
through the existing one-voice/messaging-tone gates; the Rung-3 Attention item rides
the existing aggregated/deduped Attention surface.

## 8. Rollback cost

Cheap and layered. The feature ships **dark** (`enabled` resolves via the
developmentAgent gate; fleet = off) and **dry-run-first** (`dryRun: true` ⇒
audit-only "would escalate", no spawn, no message, no I13 effect). Back-out tiers:
(1) set `monitoring.promiseBeacon.escalation.enabled: false` (restart sessions) →
exact pre-feature behavior; (2) leave `dryRun: true` → escalation observes but never
acts; (3) full revert of the PR is clean — the only persisted artifacts are optional
commitment fields (legacy commitments read as `escalationAttempts: 0`) and an
additive config block. No data migration, no agent-state repair. The I13 hook field
is additive and fail-open, so reverting the server leaves no stuck sessions.

---

## Second-pass review

**Reviewer:** independent subagent (read-only audit of artifact + real diff).

**Concern raised:** `PromiseBeacon.recordDoubleSpawn()` was defined and exposed but
had **no caller**, so the `doubleSpawnCount` metric — which spec §5/§6 designate as
the live→fleet promotion hard-stop signal — was structurally pinned at 0. The
reviewer confirmed this is NOT a runtime safety defect (the change ships dark +
dry-run-first; the real double-spawn *prevention* layers — in-process
`escRecentAttempts` idempotency, ResumeQueue deferral, live-session-bound
short-circuit, I9 global/per-tick budget — are all genuinely wired; signal-vs-
authority, No-Unbounded-Loops, and the legacy-off path all hold). The gap was that
the promotion-gating *observability* was non-functional and artifact §7 over-stated
the detection/auto-reconciliation.

**Resolution (this commit):** wired the spec §6 detection condition — `resolveInFlight`
now reads `liveSessionCountForTopic` each in-flight tick and increments
`doubleSpawnCount` once per attempt (deduped) when >1 live session is bound to the
topic; surfaced at `/commitments/escalation-metrics`. The callback is wired in
`server.ts`. Two unit tests assert the counter increments once and never on a single
session. Artifact §7 amended to state honestly that the beacon owns the detection
arm and the existing reaper closeout owns the auto-correction arm (the beacon does
not itself re-close sessions). The concern is resolved; the authority model the
reviewer verified is unchanged.
