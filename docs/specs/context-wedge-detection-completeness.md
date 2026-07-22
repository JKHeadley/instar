---
title: "Context-wedge seen latch"
slug: "context-wedge-detection-completeness"
author: "instar-codey"
status: approved
approved: true
rollout-disposition: composed
rollout-source-pr: 1536
rollout-owner-feature: context-wedge-sentinel
rollout-criteria: "A detector-positive context wedge remains latched until the existing SessionRecovery owner records genuine recovery progress."
rollout-evidence-type: endpoint
rollout-evidence-ref: /health
rollout-metrics-json: '{"cadenceHours":6,"evidenceMaxAgeHours":12,"metrics":[{"id":"successful-context-recoveries","source":"feature-summary","sourceRef":"context-recovery.successful-recoveries","direction":"at-least","threshold":1,"minSamples":1}]}'
parent-principle: "The Agent Is Always Reachable"
lessons-engaged:
  - "Verify the State, Not Its Symbol: preserve an existing positive detector result after its banner scrolls away."
  - "Reuse Before Rebuild: SessionRecovery remains the only recovery authority."
  - "Signal vs Authority: the latch remembers one boolean and makes no recovery decision."
review-convergence: "2026-07-21T09:41:31.992Z"
review-iterations: 2
review-completed-at: "2026-07-21T09:41:31.992Z"
review-report: "docs/specs/reports/context-wedge-detection-completeness-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Context-wedge seen latch

## Problem

The live context-exhaustion detector recognizes the existing `CONTEXT_PATTERNS`, and the live `SessionRecovery` engine owns all validation, cooldown, attempt, `/compact`, and respawn behavior. The monitor reads a bounded tmux tail. When a detector-positive banner scrolls out of that tail before the existing recovery path reaches genuine progress, later polls forget the observation.

Here, a **topic** is the existing numeric conversation key passed to `SessionMonitor` and `SessionRecovery`; an **ordinary poll** is the monitor's already-scheduled scan, not a new timer; and **genuine progress** is the existing `RecoveryResult.recovered === true` outcome. Topic identifiers are stable external conversation identities in the current foundation. If an operator deliberately reuses one for a different conversation, the existing manual-clear seam must be invoked first; this increment deliberately adds no mapping heuristic.

## Binding scope

Add exactly one persisted boolean per numeric topic: `wedgedSeen: true`.

- Set it only when the unchanged `detectContextExhaustion()` function returns `matched: true` from the unchanged `CONTEXT_PATTERNS` table.
- Let an ordinary monitor poll continue presenting that remembered boolean to the same `SessionRecovery.checkAndRecover()` instance. The boolean is evidence that the existing detector already matched; it is not a new detector or recovery decision.
- Clear it only when the existing recovery result reports `recovered: true`, or through an explicit manual-clear method. It never expires by wall clock.
- Persist it in the existing recovery-state file beside existing attempt state, using the existing recovery-state write owner.

The stored value contains no timestamp, session name, pattern identifier, retry count, mapping, confidence, expiry, validation result, or pane content. Absence and `false` are equivalent; only `true` rows are serialized.

## Frozen foundation

This change does not add or alter:

- a `CONTEXT_PATTERNS` entry or false-positive guard;
- pane-shape, prompt, silence, provider-wait, or network-wait classification;
- topic/session mapping validation;
- a timer, TTL, cooldown, retry, scheduler, or attempt budget;
- active-work validation, ownership validation, compaction, respawn, notification, or recovery-result semantics;
- a second sentinel or recovery engine.

`SessionRecovery` remains the sole authority. A remembered boolean reaches the same context-recovery branch, which still applies every existing guard and bound. Any non-success recovery result leaves the boolean set and schedules nothing; later presentation happens only through the monitor's already-existing poll and cooldown.

## State transitions

| Current | Existing event | Next |
|---|---|---|
| absent | existing detector matches | `wedgedSeen=true`, persisted |
| true | detector no longer matches | true |
| true | existing recovery returns any non-success result | true |
| true | existing recovery returns `recovered:true` | absent, persisted |
| true | explicit manual clear | absent, persisted |
| absent | process/server restart | absent |
| true | process/server restart | true, loaded from existing state file |

No transition depends on elapsed time.

## API seam

`SessionRecovery` exposes three deliberately mechanical methods:

- `markContextWedgedSeen(topicId)` — stores `true` and persists; called only after the existing detector matches.
- `hasContextWedgedSeen(topicId)` — reads the boolean so the monitor can continue calling the existing engine after the banner scrolls away.
- `clearContextWedgedSeen(topicId)` — explicit manual-intervention seam; successful existing recovery calls the same clear internally.

Inside `checkAndRecover`, current detector output remains preferred for the existing matched-pattern message. When no current pattern is visible but the boolean is true, the same context-recovery method runs without inventing a replacement pattern identity.

The exact latched-only call is `recoverFromContextExhaustion(topicId, sessionName, null)`. `null` affects message rendering only: the existing method omits its optional current-pattern clause. Cooldown keys remain the existing `context:${sessionName}` key and branch selection remains the existing context-recovery branch. No log or user message claims that the pattern is currently visible.

All mutations occur through the single live `SessionRecovery` instance. Its synchronous set mutation and existing whole-record state write serialize the attempt map and boolean map together before control returns to the monitor. Tests assert setting and clearing the boolean preserve existing attempt rows.

A stale true value cannot bypass a disruptive-action brake. Each presentation still enters `recoverFromContextExhaustion`, where the existing per-session cooldown and maximum-attempt check runs before `/compact`, kill, or respawn. Once exhausted, later polls return `recovered:false` without acting. The boolean's persistence changes memory of the prior signal, not those bounds.

## Acceptance criteria

1. Existing detector fixtures and `CONTEXT_PATTERNS` remain unchanged.
2. A current positive detector result persists only `{topicId: true}` state.
3. After current output becomes detector-negative, a true latch still reaches the same context recovery branch.
4. Every pre-existing ownership, active-process, attempt, cooldown, compact, and respawn guard still applies.
5. `recovered:true` clears and persists; every existing non-success result does not clear.
6. Explicit manual clear removes and persists the row.
7. Restart reloads true rows. Malformed/non-true rows are ignored by the existing tolerant state loader.
8. No clock, timer, expiry, session mapping, validation layer, retry owner, new pattern, or second engine is introduced.
9. Focused unit/integration tests, lint, build, and repository push tests pass.
10. Setting or clearing a boolean preserves every existing recovery-attempt row in the same file.

## Decision points touched

| Point | Classification (`invariant` / `judgment-candidate`) | Owner |
|---|---|---|
| Set boolean | invariant | unchanged detector result only |
| Read/persist boolean | invariant | recovery-state owner |
| Clear boolean | invariant | existing `recovered:true` signal or explicit manual intervention |
| Validate/attempt/recover | `invariant` pass-through — this change does not alter the existing deterministic authority | existing `SessionRecovery` |

## Multi-machine posture

The boolean is stored in the same machine-local recovery-state record as the existing SessionRecovery attempt state. It is a memory of a local detector observation, not a cross-machine authority or ownership record.

machine-local-justification: hardware-bound-resource — the observed tmux pane and recovery engine are local to the machine that owns the session.

## Frontloaded decisions

- Boolean-only means exactly true-or-absent; no metadata may be added in this increment.
- No time-based clear is permitted.
- Manual clear is explicit; the latch does not infer manual intervention from pane text or session mapping.
- Broader detector completeness, silent-wait proof, mapping semantics, and retry policy remain separate work.

## Open questions

None.
