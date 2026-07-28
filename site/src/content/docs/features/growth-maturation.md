---
title: Growth & Maturation Monitoring
description: The analyst layer that reads Instar's tracking systems, decides when something crosses into a real milestone, and surfaces feature maturation, stalled initiatives, and lifecycle decisions.
---

Instar accumulates a lot of *tracked* state over time — which initiatives are open, which features are incubating dark vs. proven enough to enable, how often the operator approves a spec as-is vs. changes it, how often they correct the agent. Building the sensors is only half the job. The other half is an **analyst layer** that reads all that tracked data, decides what crosses from background noise into "a concrete milestone worth telling the operator," and surfaces it on a tight cadence — without flooding.

This page covers that analyst layer and the surrounding lifecycle-monitoring subsystems.

## Growth & milestone analyst

Component: `GrowthMilestoneAnalyst`.

The analyst reads what Instar already tracks — feature rollout stages, stale initiatives, the approve-vs-change history on plans, and recurring corrections — and turns them into ONE digest governed by clear rules, instead of leaving that data piling up unread.

The lever at its core is a **tight incubation window**: a few days for low-risk features, a week at most. The window *expiring* is itself the trigger — so nothing is silently left behind. When the clock runs out, an incubating feature has either earned a promotion ("promote it?") or it never proved itself ("fix, extend, or kill it?"). Honesty is built in: elapsed time alone never promotes a feature — it has to have actually *run*. If Instar can't even tell whether it ran, the digest says "unknown" rather than pretending it passed.

- Read the latest digest: `GET /growth/digest`
- See surfaced milestones/findings: `GET /growth/findings`
- Feature status (and whether the analyst is enabled on this agent): `GET /growth/status`
- Force a fresh analysis pass: `POST /growth/tick`

Following the development-agent dark-feature gate, the analyst ships **dark for the fleet** but runs **live on development agents** — it resolves its enabled state through the standard gate rather than a hardcoded default, so a dev agent gets it the moment it lands while the fleet stays quiet until the feature has proven itself.

## Feature maturation (dark → enabled)

Component: `FeatureRolloutReconciler`.

The reconciler makes the initiative tracker self-populating: it upserts an initiative per shipped spec from artifacts that already exist — approved spec frontmatter, the instar-dev trace (spec path + PR number), and git merge state — and attaches a **rollout track** to ships-staged features whose stage is *derived from observing the live config flag* rather than self-reported. Every write is idempotent and optimistic-concurrency guarded, so re-running never duplicates. This is what lets the growth analyst answer "are features earning their way through the maturity path?" against real, observed state.

## Autonomous completion & stop judgment

Component: `CompletionEvaluator`.

For time-boxed autonomous work, the completion evaluator is an *independent* judge of "is the goal actually met?" — replacing a self-declared check with a small/fast-model judgment over a verifiable completion condition and the recent transcript. "Not met" returns a reason that becomes next-turn guidance, so a pre-approved autonomous session keeps moving instead of stopping early on a reversible decision.

- Evaluate whether the completion condition is met: `POST /autonomous/evaluate-completion`
- Evaluate whether a proposed stop is legitimate: `POST /autonomous/evaluate-stop`

### Multi-session autonomy

A development agent can run several time-boxed autonomous jobs at once — one per topic, each isolated and surviving restarts. The completion evaluator above is what keeps each one moving instead of stopping early.

- What's running: `GET /autonomous/sessions`
- Whether a new job may start (cap + budget gate): `GET /autonomous/can-start`
- Stop one topic's job: `POST /autonomous/sessions/:topic/stop`
- Stop every autonomous job: `POST /autonomous/stop-all`

`StaleSessionBackstop` is the safety net underneath: a session that drops its socket or freezes mid-task is detected, nudged once, and verified — so an autonomous job can't silently die without recovery or a recorded escalation. When a mentorship runs as a standing autonomous loop, `MentorAutonomousGuardian` keeps exactly one such session alive on a budget-gated cadence rather than letting it idle-burn or quietly stop.

## Per-feature LLM metrics

Component: `FeatureMetricsLedger`.

Every LLM-driven gate and sentinel has a cost and a hit-rate. The metrics ledger records, per call, which system invoked the LLM, what it cost (tokens, latency), and what it decided (fired / noop / error / shed) — so tuning a gate is evidence-based instead of a guess. Like the token ledger, it is **read-only observability**: it never gates, blocks, or mutates any flow.

- Per-feature cost and fire-rate over a window: `GET /metrics/features`

## Session & resource lifecycle

Components: `SessionReaper`, `AgentWorktreeReaper`, `McpProcessReaper`, `StopNotifier`.

These reclaim resources without ever losing an audit trail:

- `SessionReaper` retires idle sessions under CPU- and memory-aware pressure, recording every keep/kill *decision change* to a decision audit. Inspect live pressure and verdicts at `GET /sessions/reaper`, and the decision history at `GET /sessions/reaper/audit`.
- Every session shutoff — and every *refused* shutoff — is recorded as one line in the reap-log, served read-only at `GET /sessions/reap-log`, so a session can never disappear without a trace. `StopNotifier` sends the user-facing "your session was shut down — <reason>" notice (recovery-bounces and operator kills stay silent).
- `AgentWorktreeReaper` reclaims CLI-created worktrees that are merged, clean, and not in use — review what's reclaimable first at `GET /worktrees/agent-reaper`.
- `McpProcessReaper` cleans up orphaned MCP helper processes — inspect at `GET /processes/mcp-reaper`.

## Release readiness

When finished work sits unreleased, the release-readiness watchdog raises a single, deduped, age-escalating attention item rather than letting a stalled release go unnoticed. It ships off and is re-armable: `POST /release-readiness/enable`.

## When the agent should speak

The point of this layer is *proactive* surfacing on a tight cadence — not silence, and not a flood. A development agent runs the analyst live and is expected to bring milestones (a feature that proved itself, an initiative about to fall off, a correction pattern worth naming) to the operator as they cross the line, while the fleet stays quiet until each piece has earned its way out of incubation.
