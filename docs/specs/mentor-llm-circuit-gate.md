---
title: Gate the mentor tick on the LLM rate-limit circuit so it stops re-tripping it
slug: mentor-llm-circuit-gate
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-self-review-2026-05-31
approved: true
approved-by: Echo under the 12h autonomous deploy mandate (self-approved; flagged in PR). Directly addresses mandate task 1 ("treat the rate-limit signal as a SUSPECTED Instar bug").
approval-note: >
  Found via own-operation watch (Echo's server-stderr.log showed the LLM circuit OPENing repeatedly —
  trip #7 — on the mentor's `claude -p` forensics call). The mentor tick gated on budget (spend) but
  not on the LLM rate-limit circuit, so it kept running LLM-backed work while the provider was
  throttled and re-tripped the circuit. Small, contained, clearly-correct gate addition.
second-pass-required: false
second-pass-status: n/a-small-clearly-correct-read-only-gate-both-sides-unit-tested
eli16-overview: mentor-llm-circuit-gate.eli16.md
---

# Mentor LLM rate-limit gate (#46 — task 1)

## The bug, grounded

Echo's `server-stderr.log` showed `[llm-circuit] OPEN: provider rate-limited — pausing ALL
LLM-backed work for ~900s (trip #7); reason: Claude CLI error ... /opt/homebrew/bin/claude -p You
are the developer hat of a framework-onboarding mentor`.

`MentorOnboardingTick` (`MentorOnboardingTick.ts`) gates each tick on: a leak canary, the **budget**
(spend) gate, and the safe-window. It does NOT gate on the **LLM rate-limit circuit**
(`LlmCircuitBreaker`). So when the provider is rate-limited (circuit open), the tick still runs Stage
A (`spawnStageA` — spawns an LLM session) and Stage B (`runStageBForensics` — the `claude -p`
"developer hat"), both of which fail rate-limited and **re-trip the circuit** — and each trip pauses
ALL LLM-backed work (every monitor) for ~900s. The mentor is thus a code-side contributor to the
rate-limit churn on mentor-enabled agents (Echo). (Most agents ship the mentor dark, so this is
Echo-class today; the fix is general.)

## Fix

Add an `llmAvailable` gate to the tick, immediately after the budget gate:
```ts
if (!deps.budgetOk) return { ran: false, reason: 'budget' };
if (!deps.llmAvailable) return { ran: false, reason: 'llm-rate-limited' };
```
`llmAvailable` is computed by the runner from the shared circuit via a new read-only helper
`llmCircuitAvailable()` (`LlmCircuitBreaker.ts`): `!status().enabled || status().state === 'closed'`.
The helper is **non-mutating** — unlike the breaker's admission check, it does NOT consume a
half-open probe slot, so using it as a gate has no side effects. When the circuit is open/half-open,
the mentor backs off (skips the tick) and resumes automatically when it closes.

## Safety
- Clearly correct: when the provider is rate-limited, the tick's LLM work would just fail anyway, so
  skipping is strictly better (no wasted call, no re-trip). The mentor's forensics aren't
  time-critical; a skipped tick is picked up on the next eligible one.
- Gate order: budget → llm-rate-limit → safe-window. Budget still wins a tie (fail-closed precedence
  unchanged). Unit-tested.
- Read-only circuit query (no probe consumed). No new state, timers, or I/O.
- Scope: the observe-and-log onboarding tick (the path that produced the trips). The dark
  autonomous-fix guardian (`MentorAutonomousGuardian`) makes LLM calls too and should get the same
  gate — noted as a small follow-up; not bundled here to keep the change focused on the active path.

## Migration parity
N/A — code-only, compiled into `dist`; ships in the normal release. No agent-installed file / config /
template change → no `PostUpdateMigrator` pass.

## Agent Awareness
N/A — internal mentor-scheduler gating.

## Test plan
Unit (`MentorOnboardingTick.test.ts`, +2): `llmAvailable:false` → skips with reason `llm-rate-limited`
BEFORE any spawn/forensics (Stage A + Stage B not called); budget is checked before the llm gate (tie
→ `budget`). The existing gate-order + happy-path cases stay green (`makeDeps` defaults
`llmAvailable:true`). The `llmCircuitAvailable()` helper is exercised through the runner; the existing
`LlmCircuitBreaker` suite stays green.
