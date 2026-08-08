# `missing` false-alarms on every standby machine

**Found:** 2026-08-05, while validating tree node B4.2's premise.
**Status:** confirmed from source with a passing negative control. **New — not a Phase A finding.**

## The claim

On any multi-machine agent, the standby machine's correctly-idle guards are classified `missing`,
pushed as anomalies, and — because a standby stays standby — **persist across consecutive ticks, which
is exactly the alerting condition.** The operator receives Attention items for infrastructure behaving
correctly.

## Evidence

**1. `missing` is an unconditional anomaly** (`src/monitoring/probes/GuardPostureProbe.ts:276-283`):

```ts
case 'off-runtime-divergent':
case 'on-stale':
case 'missing':
case 'errored':
  anomalies.push({ key: anomalyKey(machineId, g.effective, g.key), ... });
  break;
```

**2. The probe has no lease or standby awareness.** Six terms, all zero:

| term | occurrences |
|---|---:|
| `standby` · `leaseHolder` · `holdsLease` · `lease` · `awakeMachine` · `serving` | **0** each |

**Negative control passed:** `anomalies.push` returns **7** in the same file, so the search works and
the zeros are real absences rather than a broken grep.

**3. Observed live.** The laptop (standby; Mini holds the lease, `holdsLease: true`, 42 jobs) reports:

```
monitoring.greenPrAutoMerge.enabled   effective=missing
scheduler.enabled                     effective=missing
```

with **0 jobs registered, 0 "Scheduler started" markers, no activity log** — all correct for a standby,
because jobs run on the lease holder only.

**4. Persistence guarantees the alert.** `missing` requires N *consecutive* ticks before alerting
(`GuardPostureProbe.ts:53`). A transient blip would clear. **A standby machine does not stop being
standby**, so the condition holds indefinitely and reliably crosses the threshold.

## Why this is the phase's signature defect again

| | |
|---|---|
| what `missing` **measures** | "enabled in config, no runtime getter registered" |
| what `missing` **certifies** | "this guard should be running and is not" — an anomaly |

Those are different sets. The gap between them is every correctly-idle guard on every standby machine.

**A passing condition narrower than what it certifies** — the same shape as the ≥12-character reason,
the borrowed counter, and the one-sided rung-3 verdict. **Fourth instance this phase, and the first one
found in the alerting path rather than in a verification path.**

## The near-miss, recorded because it is the more useful lesson

Reading `scheduler.enabled = missing` alongside zero jobs and zero boot markers, the obvious conclusion
is *the laptop's scheduler is dead and scheduled work silently isn't running there.* I was one step from
filing that.

**The control that prevented it:** check whether the thing is *supposed* to be running before calling it
dead — i.e. read the lease before diagnosing the scheduler. The Mini holds it; the laptop is correct.

> **The guard was not lying. My reading of it was wrong, and the surface invited that reading** by
> naming a neutral condition with an alarming word. That is a UX-of-instruments defect, not only a
> classification one: `missing` *tells* a reader something is broken.

## Remedy (direction, not a design)

The probe needs the fact it currently lacks: **whether this machine is supposed to be running this
guard.** The lease state is already available (`/health → multiMachine.syncStatus.holdsLease`). A guard
whose operation is lease-scoped, on a machine that does not hold the lease, is **`idle-by-role`** —
a distinct, quiet state, not `missing`.

Deliberately not designed further here: which guards are lease-scoped is itself a declaration that does
not exist yet, and **this phase's repeated lesson is that inventing a declaration the author controls is
how these defects are born.** The right home is likely the same manifest work as the rest of B0.
