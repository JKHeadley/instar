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
| `usedPercent` | **71-84%**, sampled — crosses the 75% line repeatedly (see volatility below) |
| kernel `kern.memorystatus_vm_pressure_level` | **2 (WARN)** — not 4 (critical) |
| CPU | **57-59% idle** across samples; `load-assess` verdict *OK — CPU mostly idle* |
| observed job impact | `insight-harvest`, `identity-review`, `evolution-proposal-evaluate` → `skipped (gate)`, backing off to **hourly** retries |

**The machine is not in trouble. The kernel says WARN, not critical, and the CPU is idle. We are
refusing all scheduled work anyway.**

## The metric is not WRONG — it is stricter than macOS's headline, and that is defensible

Worth stating explicitly, because the tempting (and wrong) conclusion is *"the June fix was incomplete,
go fix the metric again."* It was not, and the numbers reconcile exactly.

Measured 2026-08-04 16:55Z:

| source | figure |
|---|---|
| `instar readSystemMemoryPressure()` | **76.6% used** · free 3.53 GB / total 15.11 GB |
| macOS `memory_pressure` headline | **"System-wide memory free percentage: 49%"** |
| kernel `kern.memorystatus_vm_pressure_level` | **2 (WARN)** |

Raw pages: free 9,407 · active 243,728 · inactive 222,675 · wired 148,597 · purgeable 12 ·
**compressor 365,661**.

Our formula is `available = free + inactive + purgeable` over
`total = free + active + inactive + wired + compressor`, giving 76.6% used — and it **reproduces
exactly**, so the implementation is doing what it says. The divergence from macOS's 49% is almost
entirely the **compressor's 5.6 GB**, which our formula counts as used (it genuinely occupies physical
RAM) and macOS's headline treats as largely reclaimable.

**Both definitions are defensible. They answer different questions.** Ours is the conservative one.

### Why this strengthens the case for DEGRADED rather than a metric change

Three sources disagree about severity, and the one with the most authoritative view — **the kernel** —
says **WARN, not critical**. A binary gate forced to pick one number will be wrong in one direction or
the other at exactly the moment it matters.

**The correct response to two defensible metrics disagreeing about severity is a graduated response,
not a re-tuned threshold and not a swapped metric.** DEGRADED is precisely that: it lets the
conservative reading trigger caution without triggering refusal, and reserves refusal for the level
where all three sources would agree.

**This is also why the spec does not touch the thresholds.** Changing 75 to 85 would silence the symptom
and lose the conservative signal entirely — the signal is *correct*, it is the *response* that is too
blunt.

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

## The causal chain, evidenced (not inferred) — and it is ESCALATING

Measured 2026-08-04 19:00-19:05Z. The memory refusal and the job-gate failure co-occur **125 ms apart**:

```
19:00:00.504  [DEGRADATION] SessionManager.spawnReroutedInteractive:
                             Cannot reroute: host memory pressure is high
19:00:00.582  [DEGRADATION] ... (second spawn, same refusal)
19:00:00.629  [scheduler]   Gate for "evolution-proposal-evaluate" failed (attempt 1/3)
```

The gate runs by spawning a session (`JobScheduler.runGateAsync`), so it passes through
`evaluateRerouteGate` and inherits the refusal. **The job-gate failures ARE the memory refusals, one
layer up** — which means the raw refusal count understates the impact: each refusal also consumes a
job's retry budget.

### The backoff is compounding

| job | state observed |
|---|---|
| `evolution-proposal-evaluate` | `retry 1/6 in 1m` → `retry 2/6 in 5m` (within 80 seconds) |
| `identity-review` | `retry 5/6 in 1h` |
| `insight-harvest` | **`retry 6/6 in 2h`** — retries EXHAUSTED |

**`insight-harvest` has burned its entire retry budget and is now backing off two hours.** This is not a
steady-state degradation; each hour the gate stays blunt, the affected jobs recede further. A job at
6/6 is one failure from stopping entirely.

**This materially raises the cost of waiting**, and it is the strongest argument in this document: the
refusals are not merely wasteful, they are consuming the scheduler's own recovery mechanism.

## Evidence this is needed (both Observer conditions)

1. **The pressure state has recurred and is sustained** — **47 refusals** between 15:11 and 16:40
   (count verified exactly against the log), `usedPercent` oscillating **71-84%**, kernel WARN
   throughout.
2. **It is verifiable live** — the refusals are logged per-occurrence with the tier that caused them,
   and the job-level consequence (`skipped (gate)` → hourly backoff) is observable in the scheduler log.

## Update 19:25Z — the episode has ENDED. Read the evidence above as an episode, not a steady state.

Sampled 8 times over ~1 minute: `usedPercent` **70.0-72.9%**, kernel back to **level 1 (NORMAL)**.
Refusal rate decaying cleanly:

| window | refusals |
|---|---|
| last 60 min | 28 |
| last 45 min | 21 |
| last 30 min | 14 |
| **last 15 min** | **2** |

**There is no live bleeding as of this timestamp.** The urgency argument in the sections above is
therefore about an EPISODE that ran roughly 15:11-19:10Z, not about a condition that is ongoing now.
Recording that here so nobody reads this spec next week and believes the machine is currently on fire.

### What the ending does NOT change

The design case is untouched, because none of the *structural* facts moved:

- the gate is still **binary** — `high` and `critical` still produce identical total refusal
- the tier is still re-read **fresh on every decision**, with no dwell or hysteresis
- `usedPercent` on this host still **crosses 75 repeatedly** under ordinary load
- the affected jobs' retry budgets are **still spent** — `insight-harvest` remains at 6/6 and will not
  re-attempt for ~2 hours

So the next busy period restarts the same compounding, from wherever each job's budget happens to sit.
**This was a squall, not a repair.** The episode ending is evidence about timing and urgency; it is not
evidence against the design.

⚠️ **Method note.** I escalated the urgency of this at 19:05Z on genuine evidence and stood it down at
19:25Z on genuine evidence. Both were correct at the time. **A spec whose urgency section is written
during an episode will overstate steady-state severity** unless it is revisited after the episode ends
— which is a general hazard for any document written from live measurement, and the reason this
section exists rather than a silent edit to the numbers above.

## Open question for the reviewer

Should DEGRADED also apply in `auto` mode? In `auto`, an elevated tier degrades to the headless lane
rather than throwing — arguably already a graceful degradation, so DEGRADED may be redundant there.
**This spec proposes force-mode only**, and flags the question rather than deciding it.
