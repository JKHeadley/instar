---
title: "The Agent Is Always Reachable — guaranteed lifeline session floor + no silent resource rejection"
slug: "agent-always-reachable"
author: "echo"
eli16-overview: "agent-always-reachable.eli16.md"
parent-principle: "The Agent Is Always Reachable — A Guaranteed Reachability Floor"
review-convergence: "2026-06-26T20:25:19.520Z"
review-iterations: 2
review-completed-at: "2026-06-26T20:25:19.520Z"
review-report: "docs/specs/reports/agent-always-reachable-convergence.md"
cross-model-review: "skipped-abbreviated"
approved: true
approved-by: "echo (Justin's explicit directive, topic 28130/28744 — the agent must always be accessible, backed by an INSTAR standard)"
approved-basis: "explicit operator directive to make this an INSTAR standard; 2-reviewer convergence caught + resolved 2 blockers (existence-vs-liveness, breaker-goes-dark) + 6 majors; the change only makes the agent MORE reachable + failures MORE visible (safe direction), every new path carries its own brake; G1 ships dryRun-first on dev"
cross-model-review-reason: "live-incident standard (topic 28744); conformance + adversarial + lessons-aware reviewers ran, caught 2 blockers + 6 majors, all resolved"
---

# The Agent Is Always Reachable — guaranteed lifeline session floor + no silent resource rejection

## Problem statement

Resource gating can make the agent UNREACHABLE, silently. The 2026-06-26 incident (topic 28744): a session was reaped at its age-limit, queued for revival, and then the ResumeQueueDrainer's pressure gate held the revival INDEFINITELY and SILENTLY — the topic went quiet and the user (Justin) had to notice the silence and ask. There was no message, no guidance, and no guarantee that ANY session would come back.

This violates a foundational expectation the operator articulated (2026-06-26): **the agent itself is the solution** — it holds the tools to diagnose and free resources — so it must ALWAYS be reachable. Specifically:
1. There must ALWAYS be at least one live session per agent the user can reach — ideally the LIFELINE session (the whole point of the lifeline topic).
2. Every agent must be able to boot AT MINIMUM one active session (the lifeline) regardless of resource pressure.
3. If a session IS ever rejected/held/booted for resource reasons, that must be relayed to the user EXTREMELY CLEARLY with guidance — NEVER silent.
4. The agent frees its OWN resources first (clean stale sessions, drain worktrees, fix bad metrics) before ever surfacing a resource problem to the user.

Today: `protectedSessions` only contains `<project>-server` (not the lifeline session); the resume-queue revival + (potentially) session spawn are pressure-gated with NO lifeline exemption; and a pressure-held revival is silent until a 24h TTL expiry. (Note: the macOS os.freemem false-critical bug — fixed separately in #1287 — was what made the gate FALSELY hold here; this spec is the STRUCTURAL guarantee that holds even when a machine is GENUINELY tight.)

## Proposed design

Three structural guarantees + one constitutional standard. (Two convergence BLOCKERS — existence≠liveness, and the breaker's-terminal-state-is-dark — plus 6 majors are resolved below; 2026-06-26 reviewers.)

### G1 — Reachability floor (the lifeline always stays LIVE, never silently resource-denied)
- **The floor is LIVENESS, not existence (BLOCKER 1).** "Floor met" is NOT "a lifeline tmux session exists" — a wedged session (context-wedge, AUP-rejection, rate-limit wall) exists but rejects every message, leaving the agent dark while a naive floor reads green. The floor predicate is: a lifeline session exists AND its live tail does NOT classify as wedged/walled (reuse `StuckSignatureClassifier`/`ContextWedgeSentinel` signatures). A WEDGED lifeline is treated as floor-UNMET → it triggers the bounded FRESH respawn (clear the topic's resume UUID first, per the context-wedge recovery) rather than reporting reachable.
- **Protected from reaping:** the lifeline session is added to the reaper's protected set PROGRAMMATICALLY at boot — resolved to a SINGLE canonical session via `(lifelineTopicId, machineId)` (MAJOR 3). `lifelineTopicId` MUST be positively configured; if unset, the exemption is REFUSED (fail-closed) — never a heuristic "first interactive topic" that a non-lifeline topic could masquerade as. At most ONE exempt floor token, issued under the spawn lock (counts to one).
- **Spawn exempt from PRESSURE gating, on a RESERVED lane (MAJOR 4).** When the floor is unmet, the lifeline is (re)spawned WITHOUT the memory/calm pressure gate — but it must still get a HOST SPAWN slot, exactly when the host cap is saturated by background sentinels under load. So the floor spawn acquires on a RESERVED reachability lane (extend the F5 interactive reserve: ≥1 slot the host cap honors that background spawns can never consume). Pressure-exempt is meaningless if the host cap starves it.
- **Bounded brake that NEVER goes dark (BLOCKER 2 + No Unbounded Loops).** Distinguish two failure modes: (a) "can't boot under pressure" → the exempt+reserved spawn handles it; (b) "boots then immediately dies" (genuine crash-loop) → a breaker. The breaker does NOT full-stop (full-stop = unreachable, which the standard's title forbids): after `maxFloorRespawnsPerWindow` (default 3/30min) it drops to a SLOW heartbeat retry (1/cooldown) AND raises ONE loud notice — routed via the LIFELINE PROCESS direct-send (the Telegram poller / post-update relay), NOT an interactive-session-dependent channel (which is down). The host fork-bomb spawn-cap still bounds concurrency on top.

### G2 — No silent resource rejection (loud + guided, deterministic delivery)
- ANY session denied/held/killed for a RESOURCE reason emits ONE clear, plain-English user notice to the affected topic: WHAT, WHY ("the machine is low on memory"), GUIDANCE ("I'm freeing resources and will bring it back — message me to retry"). Never silence.
- **Gap closed:** a **pressure-held revival** (the 28744 silence) — fired after a SHORT bounded window (~2 reaper ticks, NOT the 24h TTL), through the EXISTING `ResumeQueueDrainer.raiseAggregated` funnel as a new `pressure-held` kind (MINOR c — reuse the funnel, never a parallel notifier that dodges the flood budget; the 2026-06-05 flood was a parallel path). Resolve the interaction with the eventual 24h `ttl-expired` notice so an entry that early-notifies then later expires reads as one coherent story, not two failures.
- **Deterministic delivery (MAJOR 5).** The notice is a critical-path INFRA message — it must NOT be holdable by the tone gate failing CLOSED under the very pressure it reports. It routes on the tone gate's deterministic-floor / `_formatMode` exempt path (never an LLM-unavailable hold), asserted by test.
- Subject to the existing bounded-notification budget (no flood).

### G3 — Agent-frees-resources-first (the standard + ONE structural lever)
- This is the STANDARD plus exactly one enforced lever (not a full structural pipeline — over-engineering it is scope creep). The lever: the held-revival notice fires at `min(self-remediation-done, hard-deadline)` (MINOR 8) — a slow/blocked remediation can NEVER unboundedly delay the notice past usefulness. Self-remediation = the existing AgentWorktreeReaper drain + stale-session cleanup; the notice TELLS the user the agent is already freeing resources.

### A new constitutional standard
Add to `docs/STANDARDS-REGISTRY.md`: **"The Agent Is Always Reachable — A Guaranteed Reachability Floor"** — the agent must always keep at least one LIVE reachable session (the lifeline), resource gating must never SILENTLY deny a session, and the agent frees its own resources before asking the user. **Scope (MAJOR d):** this standard governs the SESSION / resource-gating layer; the INGRESS-POLLER liveness layer (the Telegram long-poll that delivers inbound at all) is a SEPARATE guarantee already held by version-skew self-recovery + the fleet watchdog — cross-referenced, not re-implemented here (the standard does not over-claim "reachable" against a layer it doesn't own). The availability sibling of "The Operator Channel Is Sacred." **Applied through:** a test asserting the lifeline session is added to `protectedSessions` programmatically; a test asserting a pressure-held revival emits a `pressure-held` notice within the bounded threshold via the deterministic path; the liveness-floor predicate test (wedged → floor-unmet).

## Decision points touched

This MODIFIES resource gates (reaper protection + a bounded, reserved-lane, liveness-gated spawn exemption for exactly ONE canonical floor session) and ADDS a deterministic transparency relay. It does NOT weaken protection broadly. The change can only make the agent MORE reachable + resource failures MORE visible (the safe direction); every new path carries its own brake (breaker, reserved-lane cap, notice budget, hard-deadline).

## Frontloaded Decisions

- **Floor session identity** — the canonical `(lifelineTopicId, machineId)`; `lifelineTopicId` MUST be positively configured or the exemption is REFUSED (fail-closed, no heuristic fallback). Frontloaded; not weakenable.
- **Floor = liveness** — a wedged/walled lifeline is floor-UNMET (triggers fresh respawn), never reported reachable. Fixed.
- **Breaker never full-stops** — drops to a slow heartbeat + a lifeline-process-routed notice; the terminal state is never "dark." Fixed.
- **Reserved spawn lane** — the floor spawn acquires on a reachability reserve the host cap honors. Fixed.
- **Held-revival notice** — ~2 reaper ticks, through `raiseAggregated` (`pressure-held` kind), deterministic delivery, deduped, budget-bounded, hard-deadline vs self-remediation. Frontloaded; tunable threshold.
- **Rollout** — G2 (loud notice) ships ON (pure-additive, never-silent — the safe direction the operator demanded). G1 (reaper protection + reserved-lane exempt spawn) is a lifecycle-mutating change: its FLAG is default-on for the lifeline only (bounded blast radius), but its exempt-spawn ACTION honors a dryRun phase on the dev agent first (logs "would spawn floor ungated") before the live flip — the ResumeQueueDrainer/stale-pause-auto-resume pattern. A forced-pressure integration test (`pressure: () => 'critical'`) exercises both the floor spawn and the G2 notice end-to-end, since the #1287 metric fix makes the real trigger rare (MINOR 7).

## Open questions

*(none)*

## Build increments

This spec ships in two increments, each a COMPLETE, independently-correct unit (no partial fix is shipped — every increment is whole on its own; the split is by guarantee, not by leaving a guarantee half-built):

- **Increment 1 (this PR): the constitutional standard + G2 (no silent resource rejection).** The standard is written into `docs/STANDARDS-REGISTRY.md`, and the deterministic `pressure-held` notice closes the EXACT topic-28744 silent-no-revival gap — a pressure-held revival now surfaces ONE plain-English notice through the existing `ResumeQueueDrainer.raiseAggregated` funnel (the attention-queue path, never the tone-gated reply that the same pressure could hold), within a bounded window, deduped per episode, re-armed when the gate clears. This is the direct fix for the reported incident and is whole on its own: the agent is never again silently held.
- **Increment 2: G1 (the liveness floor — lifeline protected from reaping + reserved-lane pressure-exempt respawn + the breaker-never-dark).** This is a session-lifecycle-mutating change that ships dryRun-first on the dev agent per the rollout decision above; it is a tracked, scheduled next increment, not an open-ended intention. <!-- tracked: CMT-1808 --> Its absence does NOT make Increment 1 partial: G2 fixes the silence; G1 adds the stronger always-one-live-session guarantee on top.

The two map cleanly onto the operator's directive: G2 = "resource rejections must NEVER be silent" (shipped here); G1 = "at minimum one session — the lifeline — always boots" (the tracked next increment).

## Multi-machine posture
**The floor is held by the AWAKE/serving machine ONLY (the lease-holder), never every machine** — this avoids multiple live lifeline sessions across a pool. The reachability floor is asserted by the host that currently HOLDS THE LEASE (`multiMachine.syncStatus.holdsLease`); a standby machine does NOT spawn its own lifeline floor session (it would be a duplicate, and the lifeline conversation is part of the serving machine's identity). On a lease handoff, the new serving machine asserts the floor; the old one drops it (its lifeline session is closed by the existing post-transfer closeout). Single-machine agent → it always holds the (degenerate) lease → it always asserts the floor. No replication surface; the floor is a per-serving-host guarantee gated on lease ownership.
