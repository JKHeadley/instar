---
title: "Notification Emission Gate Brief (#73 compaction/context false-positive lane)"
slug: "notification-emission-gate-brief"
status: draft-brief
tier: 2
created: "2026-06-05"
author: "instar-codey"
approval: "not approved; brief first, no src changes"
related:
  - docs/specs/notification-ux-coherence.md
  - docs/specs/compaction-recovery-proxy-filter.md
  - docs/specs/compaction-resume-payload.md
  - docs/specs/compaction-preamble-tone-and-intent.md
---

# Notification Emission Gate Brief

## Scope

This is the #73 brief for the compaction/context false-positive lane. It is not
an implementation spec yet and does not authorize source changes. The goal is
to turn the live topic-505 / Codex dogfood findings into a convergable spec:
stop low-confidence recovery/status signals from becoming user-visible claims
like "actively working" or "message dropped" when the stronger lifecycle facts
say recovery is still in progress or the message was later handled.

This is distinct from `notification-ux-coherence.md`. That spec shapes where
self-health notices land in Telegram. This brief is about whether a detector has
enough authority to emit a notice at all.

## Grounded Incidents

### Topic 6795: compaction recovery false negative, already fixed

The older compaction bug was mechanical: `recoverCompactedSession` treated
PresenceProxy standby and server lifecycle lines as real agent answers. The
fixes already landed:

- `isSystemOrProxyMessage()` and `findLastRealMessage()` centralize the
  "real answer versus system/proxy traffic" predicate.
- Compaction recovery now walks backward past `🔭`, `✓ Delivered`, and session
  lifecycle messages before deciding whether a user message is unanswered.
- The compaction resume payload now carries real topic context and a tighter
  preamble, so the recovered agent answers the user's last message instead of
  inventing a status recap.

Those fixes are the baseline. #73 must not regress them.

### Topic 505: recovery worked, user-facing noise was false-positive

The newer false-positive lane is notification authority. The observed symptoms
were:

- PresenceProxy generic fallbacks asserted that the agent was "actively working"
  when the LLM summary path had timed out, returned empty output, or could not
  safely read the Codex pane.
- Context-exhaustion/restart/respawn notices repeated even though recovery was
  generally succeeding.
- Dropped-message notices asked the user to resend, then the agent later handled
  the message.
- Pending relay held stale ACK/status rows after transient failures.

There were real reliability signals underneath the noise: context exhaustion
occurred, recovery ran, LLM summarization was unavailable, and relay delivery
state had transient failures. The bug is that low-context signals had too much
direct user-facing authority.

### Task #78: contradictory relay, standby, and watchdog narration

Task #78 is the cleanest evidence for a single emission authority. Within one
ten-minute window, three subsystems narrated contradictory states to the user:

- The relay reported a message as undelivered after the agent had already
  acknowledged it.
- PresenceProxy emitted four "actively working" receipts.
- A watchdog surfaced a stuck-alert.

No one detector was malicious; each was speaking from a local slice of state.
The failure was architectural: direct emission authority was distributed across
the relay, standby/proxy, and watchdog paths. Under this brief, each subsystem
would emit a structured signal into one gate, and the gate would decide whether
the incident should be user-visible as `emit`, `record-only`, or `escalate`.

## Design Principle

Signals do not get direct user-facing authority.

Detectors can report:

- LLM summary unavailable or unsafe.
- Deterministic active-work signal present.
- Deterministic stalled/dead signal present.
- Context exhaustion detected or recovered.
- Respawn/restart requested, succeeded, repeated, or failed.
- Pending/dropped message envelope state changed.

A single emission authority decides:

- `emit`: send one high-confidence/actionable user-visible notice.
- `record-only`: write the audit row, keep monitoring, do not interrupt.
- `escalate`: queue attention or send a coalesced incident notice.

The gate must be deterministic and cheap. It may consume an already-computed LLM
summary or classifier output, but it must not add a new blocking LLM call on the
notification path.

## Proposed Shape

Add `NotificationEmissionGate` as a separate authority, not as an expansion of
`SentinelNotifier`.

Reason: `SentinelNotifier` is documented and tested as a delivery sink, not a
gate. It can provide useful coalescing and JSONL logging patterns, but emission
authority belongs in a module whose contract says it can choose `emit`,
`record-only`, or `escalate`.

Inputs:

- `source`: `presence-proxy`, `compaction-recovery`, `context-exhaustion`,
  `respawn`, `restart-dampener`, `lifeline-drift`, `pending-relay`,
  `dropped-message`, `sentinel`.
- `topicId`, `sessionName`, `framework`.
- `incidentKey`: stable per topic/session/recovery cascade.
- `tier` or lifecycle phase.
- `messageIntent`: ack, status, recovery, failure, actionable.
- `confidenceSignal`: LLM summary, deterministic state, delivery confirmation,
  recovery outcome, envelope state.
- `deterministicState`: active-work, idle, stalled, dead, context-exhausted,
  recovered, unknown.

Outputs:

- `emit` with fixed, non-alarming copy and metadata.
- `record-only` with a reason.
- `escalate` with attention/lane/coalescing metadata.

Every decision writes a suppression/emission ledger row.

## Required Behaviors

1. PresenceProxy generic fallbacks must not assert "actively working" when the
   summary is unsafe, unavailable, or empty.

2. Codex fallback suppression is gated on positive deterministic evidence:
   - LLM unavailable + active-work signal present: `record-only`, schedule the
     next existing tier, no generic user-visible message.
   - LLM unavailable + no active-work signal: no generic "working" claim; route
     to the existing tier-3 deterministic assessment within the current SLA.
   - Deterministic tier-3 stalled/dead remains eligible to emit or escalate
     through the gate.

3. Deterministic stalled/dead is a signal into the gate, not a self-emitting
   authority. This prevents the old anti-pattern from moving one layer down.

4. Restart/respawn notices are per incident, not per callsite. A respawn may be
   silent only after one lifecycle notice for that same incident is confirmed
   delivered.

5. Repeated respawns in a rolling window become a separate crash-loop signal and
   break silence through attention/escalation.

6. `RestartCascadeDampener` and `LifelineDriftPromoter` must route restart
   notice decisions through the gate or share its incident identity. Two modules
   independently deciding restart visibility is the highest integration risk.

7. Dropped-message wording and dropped-message reconciliation are separate:
   softer copy is useful, but durable correctness requires suppressing or
   retracting the drop notice when the same delivery envelope is later observed
   delivered/consumed.

8. Core suppression is default-on. Users should not need to enable "do not send
   low-confidence false-positive status claims."

## Observability

Write a durable JSONL decision ledger modeled on `logs/sentinel-events.jsonl`.

Minimum fields:

- timestamp
- topicId
- sessionName
- framework
- source
- incidentKey
- tier or phase
- decision: emit, record-only, escalate
- reason
- deterministicState
- confidenceSignal summary
- snapshotHash
- deliveryConfirmed
- recoveryOutcome
- envelopeId or envelopeHash when applicable

Derived metrics:

- false-suppression rate: record-only followed by genuine stuck/dead state.
- false-alarm rate: emitted notice followed by normal handling/recovery.
- time-to-genuine-surface for real stalls.
- context recovery attempts/success/failure.
- PresenceProxy suppression count by tier/framework/reason.
- pending relay queued/replayed/suppressed/dropped/consumed counts.
- restart/respawn notices emitted versus suppressed by incident.

The false-suppression and crash-loop checks must be computed by the gate or a
poller. Manual log-grepping is not an acceptable runtime safety mechanism.

## Migration and Awareness

- Any config knobs land in `ConfigDefaults` and `PostUpdateMigrator` with
  existence-checked, idempotent defaults.
- The core "do not assert low-confidence working status" behavior is default-on.
- If the feature changes user-visible behavior enough that an agent may be asked
  "why am I seeing fewer status pings?", update the agent awareness template and
  migrate existing generated agent docs with a content-sniffed patch.
- No hook or skill migration is expected for the gate itself.

## Testing Requirements

Unit:

- PresenceProxy + Codex + LLM unavailable + deterministic active-work: no
  generic visible message; tier progression continues.
- PresenceProxy + Codex + LLM unavailable + no active-work: no generic
  "working" claim; tier-3 deterministic path remains eligible.
- Gate emits all three outputs (`emit`, `record-only`, `escalate`) for concrete
  source fixtures.
- Restart notice dedup keys by incident, not callsite.
- Silent respawn requires confirmed prior delivery for that incident.
- Crash-loop threshold breaks silence.
- Dropped-message notice suppresses/retracts on authoritative envelope consumed
  state, not on response-text guessing.

Integration:

- Topic-505-like cascade: duplicate inbound image/message traffic, context
  exhaustion, LLM summary unavailable, stale pending relay rows. Verify recovery
  can continue while user-visible output is coalesced.
- RestartCascadeDampener and LifelineDriftPromoter delegate to the gate or share
  its incident identity.
- Suppression/emission ledger records every internal transition.

E2E lifecycle:

- Boot the production server path and verify the gate is alive on the real init
  path, not constructed as a null/no-op dependency.
- If an observability route is added, it returns 200 on a real server and never
  503s due to missing wiring.
- A real or harnessed session reaches the tier-3 deterministic surface within
  the existing 5-minute PresenceProxy cadence or the ActiveWorkSilenceSentinel
  window, whichever fires first.

Migration:

- New installs get defaults.
- Existing installs get defaults through migration.
- Generated agent awareness docs are patched when applicable.

## Rollout Plan

1. Converge this brief into a full spec with code-owner and cross-model review.
2. Implement the pure gate and ledger first, with no callsite routing.
3. Route PresenceProxy generic fallback decisions through the gate.
4. Route compaction/context-exhaustion restart and respawn notices through the
   same incident-key path.
5. Reconcile dropped-message notices against delivery-envelope consumed state.
6. Fold SentinelNotifier escalations into the gate later, after the topic-505
   sources are stable.

## Open Questions

- Should the first implementation expose a read-only route for the ledger, or
  keep it file-only and rely on Process Health/DegradationReporter views?
- What is the exact incident-key shape shared between restart dampening,
  context-exhaustion recovery, lifeline drift, and respawn?
- Which delivery-envelope state should be authoritative for drop-notice
  reconciliation in each transport: PendingRelayStore, DropPickup,
  warmSessionInbox, or MessageProcessingLedger?
- Does the agent awareness update belong in the gate PR or the first callsite
  routing PR?
