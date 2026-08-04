# Tranche 4 — the 20 `on-confirmed` guards: what rung 3 would actually COST

**Measured 2026-08-04 06:38Z (Mini).** Ruling 4 made this a **full audit, not a sample** — these are the
guards the system currently trusts, so wrong trust here is the most dangerous class.

## First, what these 20 actually are

**Every one is a RUNTIME guard** — sentinel, reaper, watchdog, reconciler, scheduler, governor. **Not one
is a lint.** That matters, because the three rung-3 passes I obtained tonight were all lint-class: inject
a file, run the script, read the exit code, delete. **None of that method transfers here.**

And per the A0 finding, `on-confirmed` for all 20 means exactly one thing: **the guard reports a
heartbeat.** It is rung 2 evidenced by a pulse. **Rung 3 has never been attempted on any of them.**

## Testability classes — the real cost driver behind Tranche 4

### A. Safely injectable in isolation (test locally, no live blast radius) — **5**

| guard | injection |
|---|---|
| `intelligence.testRunnerCap` | hold a suite slot, attempt a second suite → must be refused |
| `intelligence.selfActionGovernor` | drive a registered self-action class past its ceiling → must deny |
| `monitoring.blockerLifecycleLedger` | settle a blocker without an exhaustion run → must refuse |
| `monitoring.throughputFloor` | feed a flatlined window → must observe (pull-only, so verify it records) |
| `multiMachine.seamlessness.ws13Reconcile` | present a divergent pin record → must reconcile/flag |

**Cost: low.** Each is a bounded state machine with an inspectable status route.

### B. Injectable only against a THROWAWAY agent + demo channel — **9**

`activeWorkSilenceSentinel` · `contextWedgeSentinel` (+`autoRecovery`) · `socketDisconnectSentinel` ·
`strandedTopicSentinel` · `sessionReaper` · `resumeQueue` · `watchdog` · `permissionPromptAutoResolver`

Each requires a **genuinely stuck / wedged / disconnected session** to catch. Faking the condition on live
infrastructure risks killing real work — `sessionReaper` and `watchdog` literally kill sessions.

**Cost: high.** Needs the disposable-agent harness the Live-User-Channel Proof standard already
describes. **This is the single largest cost item in the whole 68-leaf tree**, and it is concentrated in
the tranche the system trusts most.

### C. Requires a real second machine in a real fault state — **4**

`machineCoherence` · `missingLoginSession` · `autonomousLivenessReconciler` ·
`sessionPool.holdForStability`

These only bite when a peer machine genuinely diverges, loses a login, dies mid-run, or wobbles.

⚠️ **`machineCoherence` is the exception and it is already effectively proven.** Tonight it detected a
real version/guard divergence **unprompted**, while I was independently confirming the same divergence by
hand — 155 ticks, 0 errors, calm-classified, one prior episode closed as restored. **A naturally occurring
violation, caught, verified against an independent measurement.** That is not a deliberate injection, but
it is the same epistemic content, and I would argue it satisfies rung 3 on the evidence available.

**Cost: high, except `machineCoherence` which is ~free — the evidence already exists.**

### D. Structurally awkward — **2**

`degradedTmuxGuard` (needs a degraded tmux, which breaks the harness you would observe it with) and
`scheduler` (its "violation" is failing to fire — an absence, so the test is a *timeout*, not a catch).

**Cost: needs a bespoke design per guard.**

## What this tells the architect

1. **Tranche 4 is not the cheap tranche.** I sequenced it last for low expected yield; measured, it is the
   **most expensive** because every member is runtime-class. The ordering is still right — but for the
   opposite reason to the one I gave.
2. **9 of 20 are blocked behind one shared harness.** Building the throwaway-agent + demo-channel rig once
   unblocks nearly half of Tranche 4 — the highest-leverage single build in the tree, and it is
   infrastructure, not per-node work.
3. **1 of 20 is already effectively proven** (`machineCoherence`) — worth banking rather than re-testing.
4. **Only 5 of 20 can be done with the method that worked tonight.**

## Honest limits

- This is a **testability classification, not a verdict**. No guard's rung-3 status changes here; all 20
  remain `on-confirmed` = rung 2.
- The classification is **my judgement from each guard's declared critical path**, not from reading each
  implementation. A guard I filed under B might turn out to be A once someone reads it. **That is exactly
  the "topical match is a candidate, not a verdict" caveat I applied to Tranche 2, applied here to myself.**
