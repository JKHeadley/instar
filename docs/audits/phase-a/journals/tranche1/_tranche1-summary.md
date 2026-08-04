# Tranche 1 — sweep result (all 9 load-bearing, not-confirmed guards, BOTH machines)

**Measured 2026-08-04 06:15Z.** Verdicts are per-machine per the architect amendment.

| guard | Mini | Laptop | divergent |
|---|---|---|---|
| mesh reachability recovery | on-dry-run | on-dry-run | |
| **durable operator inbound delivery** | **on-dry-run** | **on-unverified (LIVE)** | **YES** |
| topic reachability when owner dies | on-dry-run | on-dry-run | |
| **serving-lease hand-back** | **on-dry-run** | **OFF** | **YES** |
| correction-derived instance fixes | on-dry-run | on-dry-run | |
| apprenticeship sign-off gate | on-unverified | on-unverified | |
| mesh partition alerting | on-unverified | on-unverified | |
| deliberate placement persistence | on-unverified | on-unverified | |
| **autonomous execution on a peer** | **OFF** | **on-dry-run** | **YES** |

## `aligned: FALSE` on all 9

Not one reaches `effective` on either machine. Six are dry-run or unverified on both; three differ.

## ⭐ 3 of 9 DIVERGE ACROSS MACHINES — one third of the tranche

**The amendment was added yesterday and has now paid for itself three times in the first tranche.** A
fleet-wide verdict on any of these three would have been actively wrong about one machine:

1. **Durable operator inbound delivery** — Mini merely observes; the laptop actually takes custody. On the
   Mini an undeliverable operator message is **not durably held**. (Full node:
   `durable-operator-inbound-delivery.md`.)
2. **Serving-lease hand-back** — dry-run on the Mini, **entirely OFF on the laptop**. The mechanism that
   returns serving to the intended captain after a failover does not exist on one of the two machines it
   arbitrates between.
3. **Autonomous execution on a peer** — **OFF on the Mini**, dry-run on the laptop.

## ⚠️ #3 lands directly on the ratified placement policy

The plan places **worker lanes on the laptop** with orchestration on the Mini. `peerExecution` is the
guard for exactly that — *autonomous execution on a paired peer machine*. It is **off on the orchestration
machine and only observing on the worker machine.**

So the placement policy's own safety guard is, right now, `aligned: false` on both ends. That is a
prerequisite finding for scaling lanes, not a detail — and it joins the memory-metric defect (which would
have refused worker spawns on the laptop) as the second measured obstacle in front of the same policy.

## Method note

Rung 3 (injected violation) was **not attempted on any of the 9**, and that is a verdict rather than an
omission: a dry-run guard is structurally incapable of biting, and an `off` guard has nothing to bite
with. For the one guard that is genuinely live (inbound queue, laptop), the counters show it has **never
taken custody of anything** — so "live" and "proven" remain separated even there.
