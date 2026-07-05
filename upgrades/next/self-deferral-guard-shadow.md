---
user_announcement:
  - audience: agent-only
    maturity: experimental
---

## What Changed

Added the observe-only ("shadow") phase of the Turn-End Self-Deferral Guard: a meaning-based judge on
the turn-end surface that records when a turn-ending message hands the operator a decision about work
the agent could do within its own means (the "you deferred again" pattern that slipped every existing
guard on 2026-07-04). It folds one new allow-class rule (`U_SELF_DEFERRAL`) plus four fields into the
SINGLE existing `UnjustifiedStopGate` turn-end call — no new LLM call, no new hook, no new route. The
judge receives the recent user turns (a bounded, fail-open transcript tail-read) so it can distinguish a
genuine operator decision from a self-deferral. Verdicts are recorded to the existing `StopGateDb`
(new columns + a real `ALTER TABLE` migration and age-based retention, both of which did not previously
exist). It BLOCKS NOTHING — it only records, to produce the telemetry needed to later decide whether the
blocking phase (deferred) is worth building. Dev-agent-gated (on for a development agent, dark on the
fleet).

## What to Tell Your User

Nothing proactive — this is an internal, observe-only telemetry feature that changes no behavior. If a
user asks whether the agent has a check for handing work back to them that it could do itself, the
answer is: yes, a quiet watch-only version now records those moments so we can measure how often it
happens and how accurately it is detected, before ever deciding whether the agent should actively step
in. It never blocks or delays a message.

## Summary of New Capabilities

- A turn-end judge that classifies self-deferral (agent hands the operator agent-ownable work) and
  records it, with recent-user-turn context, on every finished turn.
- Recording rides the existing stop-gate call (zero new LLM calls); it blocks nothing and changes no
  message.
- New `StopGateDb` columns with a built idempotent column migration (existing agents gain the columns on
  update) and real age-based retention.
- Dev-agent gated (`monitoring.selfDeferralGuard`); off-state is byte-for-byte the prior behavior.
- The enforce/blocking phase is deliberately DEFERRED behind separately-gated preconditions (spec §10).

## Evidence

- Spec: `docs/specs/turn-end-self-deferral-guard.md` (v4, Phase A CONVERGED — 4 review rounds; operator
  approved the observe-only build, topic 29836, 2026-07-05).
- 55 tests across 5 new suites + updated rule-count assertions: `tests/unit/self-deferral-guard.test.ts`
  (14), `tests/unit/stopGateDb-self-deferral-migration.test.ts` (6),
  `tests/unit/stopGateTranscriptTail.test.ts` (13), `tests/integration/self-deferral-guard-route.test.ts`
  (2), `tests/e2e/self-deferral-guard-feature-alive.test.ts` (2), `tests/unit/UnjustifiedStopGate.test.ts`
  (regression). `tsc --noEmit` clean.
