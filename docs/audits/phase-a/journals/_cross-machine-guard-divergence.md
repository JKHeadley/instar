# Cross-machine guard divergence — the fleet-coherence number

**Measured 2026-08-04 06:18Z**, `/guards` on both machines, compared key-by-key.

| | |
|---|---|
| guards present on **both** machines | 89 |
| **agree** on `effective` | 73 |
| **DIVERGE** | **16 (18%)** |
| present on Mini only | 1 |
| present on Laptop only | 4 |

## The divergent 16

| guard | Mini | Laptop | load-bearing |
|---|---|---|---|
| `agentSleep` | off | on-unverified | |
| `agentWorktreeReaper` | on-dry-run | **on-confirmed** | |
| `autonomousHeartbeat` | off | **on-confirmed** | |
| `blockerLedger` | off | on-unverified | |
| `burnDetection` | on-unverified | **off** | |
| `greenPrAutoMerge` | off | missing | |
| `mcpProcessReaper` | off | on-unverified | |
| `missingLoginSession` | **on-confirmed** | on-dry-run | |
| `orphanedWorkSentinel` | on-blind | off | |
| `promptGate` | on-unverified | **off** | |
| `sentinelTelegramEscalation` | off | on-unverified | |
| `staleBackstop` | off | on-unverified | |
| `preferredCaptainHandback` | on-dry-run | **off** | **YES** |
| `peerExecution` | **off** | on-dry-run | **YES** |
| `inboundQueue` | on-dry-run | on-unverified | **YES** |
| `scheduler` | **on-confirmed** | missing | |

## ⭐ It drifts in BOTH directions

This is not "one machine is behind the other." **Some guards are stronger on the Mini**
(`missingLoginSession` confirmed vs dry-run, `promptGate`/`burnDetection` on vs off) and **some are
stronger on the laptop** (`autonomousHeartbeat` and `agentWorktreeReaper` confirmed vs off/dry-run).

A single agent's two machines have independently drifted apart in opposite directions on different guards.
There is no "canonical" machine to copy from.

## ⚠️ NOT ALL 16 ARE DEFECTS — and I am not going to imply they are

At least one is **correct role behaviour**: `scheduler` reads `missing` on the laptop because that machine
is in **standby**, and only the lease-holder runs the scheduler. I verified that earlier tonight from its
own log (`Scheduler skipped (standby mode)`) after the grounding gate stopped me calling it a defect.

**So the honest split is: 16 divergent, ≥1 role-explained, the remaining 15 unclassified.** Classifying
each is per-node Level 2 work, not something to assert from a table. What the number establishes is the
*size of the surface* where a fleet-wide verdict is unsafe — not a defect count.

## What this settles for the plan

- **The amendment is not a formality.** 18% of guards would receive a wrong fleet-wide verdict.
- **Every Level 2 node must measure both machines**, not sample one. The tree is 68 leaves; this says the
  per-machine cost is unavoidable for a meaningful fraction of them.
- **3 of the 16 are load-bearing**, all three from Tranche 1, including the guard the ratified worker-lane
  placement policy depends on.
