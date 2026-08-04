# The cost map — what auditing 68 leaves actually requires

**2026-08-04 06:50Z.** Tranches 3 and 4 classified by **what a rung-3 test would require**, not by guess.
Tranche 1 (9) is included; Tranche 2 (16) is standards-not-guards and sits outside this map.

## Combined runtime guards (Tranche 3's 40 + Tranche 4's 20 = 60)

| class | what rung 3 needs | T3 | T4 | **total** |
|---|---|---|---|---|
| **A** | injectable in isolation — bounded state machine + status route | 1 | 5 | **6** |
| **B** | **throwaway agent + demo channel + live session control** | 28 | 9 | **37** |
| **C** | a real second machine in a genuine fault state | 5 | 4 | **9** |
| **D** | bespoke per-guard design (absence-tests, self-breaking harnesses) | 6 | 2 | **8** |

## ⭐ THE NUMBER: 37 of 60 runtime guards — 62% — are blocked behind ONE shared harness

**Building the throwaway-agent + demo-channel rig once unblocks nearly two-thirds of the runtime guard
audit.** It is the single highest-leverage build in the entire plan, and it is *infrastructure*, not
per-node work — so it does not scale with the 68 leaves, it collapses them.

The Live-User-Channel Proof standard **already describes this rig** (volatile/permission scenarios run on
throwaway agents + demo channels, never the live operator channel). So this is not a new invention; it is
an existing standard's tooling, currently unbuilt, sitting on the critical path of 37 audit nodes.

## What is genuinely cheap

**6 guards (class A)** can be tested with the method that produced tonight's three rung-3 passes: inject,
run, read the exit code, remove, control. **Only 6 of 60.** Tonight's method — which felt fast and
productive — covers **10% of the runtime surface**.

That is the honest scale correction. **Three passes in fifteen minutes does not extrapolate.**

## Why this changes sequencing

I proposed tranche order 1→4 by *measured risk*, and the architect approved it. The cost map does not
overturn that, but it adds a parallel track:

> **The harness is not a tranche — it is a prerequisite that 37 nodes share.** Sequencing tranches
> without building it means 37 nodes each stall at rung 3 and get recorded as `unmeasured`, which is a
> worse outcome than a slower start.

**Recommend:** build the class-A nodes now (6, cheap, immediate rung-3 evidence), and start the harness in
parallel as its own work item rather than discovering its necessity 37 times.

## Honest limits

- **Classification is from each guard's declared critical path and key, not from reading 60
  implementations.** A guard filed under B may prove to be A once someone reads it. This is a **planning
  estimate with a named method**, not a verdict — the same caveat I applied to Tranche 2 and to Tranche 4,
  applied again here.
- The A/B/C/D split is **mine**, not the contract's. If the architect wants different cut-lines the
  numbers move; the *shape* (one dominant shared blocker) is what I would defend.
