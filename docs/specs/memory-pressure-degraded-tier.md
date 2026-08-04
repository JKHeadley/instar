---
title: "Memory pressure: a DEGRADED tier at WARN instead of refuse-all"
slug: "memory-pressure-degraded-tier"
author: "echo"
eli16-overview: "memory-pressure-degraded-tier.eli16.md"
parent-principle: "No Silent Degradation to Brittle Fallback"
sanction: "Observer/Orchestrator ruling 2026-08-04 (option C), under Justin's plan-scoped approval relayed 2026-08-03 20:21 PDT. Build gated on the pressure state recurring and being verifiable live — BOTH conditions now met; see Evidence."
approved: false
---

# Memory pressure: a DEGRADED tier at WARN instead of refuse-all

**Status: DRAFT, awaiting convergence and approval. NOT built.** Written ahead of approval so the build
can start the moment the ruling lands, per the standing "prepare, don't presume" discipline.

## The problem, measured live

`SessionManager.evaluateRerouteGate` treats memory pressure as binary:

```ts
const pressure = this.currentMemoryPressure();          // low | moderate | high | critical
const pressureElevated = pressure === 'high' || pressure === 'critical';
if (reroutedCount < maxRerouted && !pressureElevated) return { allow: true };
// force mode: throw. auto mode: degrade to headless.
```

`high` begins at **75% used**. Under `subscriptionPath.mode: 'force'` an elevated tier **throws**, so
every job/A2A spawn is refused.

**Measured on the live Mini, 2026-08-04:**

| measure | value |
|---|---|
| reroute refusals, 15:11 → 16:40 | **47** (34 by 16:10, 13 more in the following 25 min) |
| `usedPercent` | **80-82%** → tier `high` |
| kernel `kern.memorystatus_vm_pressure_level` | **2 (WARN)** — not 4 (critical) |
| CPU | **57% idle**; `load-assess` verdict *OK — CPU mostly idle* |
| observed job impact | `insight-harvest`, `identity-review` → `skipped (gate)`, backing off to **hourly** retries |

**The machine is not in trouble. The kernel says WARN, not critical, and the CPU is idle. We are
refusing all scheduled work anyway.**

## The reading is VOLATILE, and the gate has no hysteresis

Measured 2026-08-04 16:50Z, sampling `usedPercent` every ~6 s:

```
74.5%  → moderate  (admit)
82.2%  → high      (REFUSE)
82.2%  → high      (REFUSE)
84.0%  → high      (REFUSE)
84.0%  → high      (REFUSE)
80.3%  → high      (REFUSE)
80.3%  → high      (REFUSE)
80.3%  → high      (REFUSE)
```

**A 9.5-point swing inside 48 seconds, straddling the 75% refuse threshold.**

`currentMemoryPressure()` is called **fresh inside `evaluateRerouteGate`** on every admission decision —
there is no cached tier, no dwell, no hysteresis. So **a job's fate depends on which instant it happens
to be evaluated at**, and two identical jobs seconds apart get opposite answers.

Practical effect over the same period: **0 job completions in 30 minutes**, while `usedPercent` spent
part of that window *below* the threshold.

**This matters for the design, not just the diagnosis.** A DEGRADED tier that is also re-evaluated
per-call would flap between "admit constrained" and "admit freely" just as the current one flaps
between admit and refuse. **DEGRADED should therefore carry dwell/hysteresis**: once entered, remain in
DEGRADED for a minimum interval, and require a sustained reading — not a single sample — to leave it.

That is an addition to the ruled design, surfaced by measurement, and it is flagged here rather than
assumed into the build.

## Why refuse-all is the wrong response to WARN

`high` and `critical` currently produce **identical behaviour** — total refusal — which discards the
distinction the tiers exist to express. A WARN-level host can still do work; it should do *less* work,
*more carefully*, not none.

The existing thresholds are also not the defect (the 2026-06-26 fix corrected the *measurement*; this
spec changes the *response*). **Nothing in this spec moves a threshold.**

## Proposed change

Introduce a **DEGRADED** admission tier between "allow freely" and "refuse".

| tier | condition | behaviour |
|---|---|---|
| normal | `low` / `moderate` | unchanged — admit up to `maxRerouted` |
| **DEGRADED** | `high` | **admit, but constrained** (below) |
| refuse | `critical` | unchanged — refuse; force mode throws |

**DEGRADED constraints (all three, together).** Identifiers verified against the tree, so this is
implementable as written:

1. **Serialize starts** — at most ONE reroute spawn in flight at a time, regardless of
   `subscriptionMaxRerouted` (`SessionManager:2836`, default **3**).
2. **Reduced concurrency bound** — the effective cap becomes `degradedMaxRerouted` (new, default **1**)
   instead of `subscriptionMaxRerouted`, evaluated at the same place the current cap is
   (`reroutedCount < maxRerouted`, `SessionManager:2840`).
3. **Defer low-priority** — two existing fields carry this, no new taxonomy required:
   - `deferrable?: boolean` (`types.ts:1057`) — and its own contract already states *"a `gating:true`
     call is ALWAYS treated as non-deferrable"*, which is exactly the safety property DEGRADED needs:
     **a gate can never be deferred by memory pressure.**
   - `JobDefinition.priority: 'critical' | 'high' | 'medium' | 'low'` (`types.ts:1575`) — DEGRADED
     admits `critical`/`high`, defers `medium`/`low`.

   Deferred spawns take the EXISTING degrade path (auto mode → headless; force mode → the current
   refusal), so no new refusal behaviour is introduced — only a narrower set of things it applies to.

`critical` keeps refusing, unchanged. The no-fallback semantics of `force` mode are unchanged.

## What this is NOT

- **Not a threshold retune.** 90/75/60 are untouched. The Observer explicitly ruled against a bare
  threshold change, and this spec does not smuggle one in.
- **Not a mode flip.** `subscriptionPath.mode` semantics are untouched.
- **Not a new authority.** The gate keeps its authority and its refusal power at `critical`; DEGRADED
  only widens what it admits at WARN, which is the direction that *removes* an over-block.

## Signal vs authority

`currentMemoryPressure()` remains a **detector** producing a tier. `evaluateRerouteGate` remains the
**authority**. This spec changes only the authority's *response function* — three tiers of response
where there were two. No detector gains authority; no new blocking logic is introduced anywhere.

## Rollout

Gated behind `sessions.memoryPressure.degradedTier` (default **off**), so the shipped default is
byte-identical to today's behaviour. Enable on the dev agent first, observe one pressure episode, then
fleet.

## Testing (required before build is complete)

**Control — must fail against pre-fix code:**
- at `high` with force mode, a deferrable spawn is refused AND a non-deferrable spawn is **admitted**
  (pre-fix: both throw)
- at `high`, two concurrent spawn requests serialize (pre-fix: both throw)

**Both sides of the boundary — a "always admit" regression must not pass:**
- at `critical`, force mode still **throws** (unchanged)
- at `low`/`moderate`, admission is unchanged and NOT serialized
- at `high` with the flag **off**, behaviour is byte-identical to today

**Live proof:** one job observed spawning successfully at `usedPercent >= 75` with the kernel at WARN.

## Evidence this is needed (both Observer conditions)

1. **The pressure state has recurred and is sustained** — 47 refusals across 90 minutes, `usedPercent`
   80-82%, kernel WARN, continuously.
2. **It is verifiable live** — the refusals are logged per-occurrence with the tier that caused them,
   and the job-level consequence (`skipped (gate)` → hourly backoff) is observable in the scheduler log.

## Open question for the reviewer

Should DEGRADED also apply in `auto` mode? In `auto`, an elevated tier degrades to the headless lane
rather than throwing — arguably already a graceful degradation, so DEGRADED may be redundant there.
**This spec proposes force-mode only**, and flags the question rather than deciding it.
