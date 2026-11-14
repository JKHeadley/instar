# Side-Effects Review — a reserved rerouted slot for confined feedback-executor spawns

## Summary of the change
Files: `src/core/SessionManager.ts` (`rerouteAdmissionCap` takes a kind, `evaluateRerouteGate` takes the kind from the spawn, `confinedRerouteCapacity` reads the confined cap, new `setConfinedRerouteReserve`), `src/feedback-factory/execute/buildFeedbackExecutor.ts` (turns the reserve on while the executor is enabled, not dry-run and owns the queue on this machine), tests (`session-manager-confined-reroute` five cases, `execute-wiring` one), spec + ELI16 amendments. Tier 1: about 45 lines of code, reversible by revert, no state or config. Measured cause: 0 of 12 executor starts on 2026-11-12 from 16:00 PST; `rerouted-session cap reached (7/7)` even after raising `maxRerouted` 6 → 8.

## Decision-point inventory
The reroute admission gate (an existing block on spawns under `force`) changes how its one cap is split. Ordinary spawns: `max − 2` when `max ≥ 4` AND a live executor that owns the queue on this machine has asked for the reserve, else `max − 1` (or `max` on a one-slot host). Confined spawns: `max − 1`. Scheduler jobs: `max`. The total bound and the memory-pressure refusal are unchanged.

## 1. Over-block
Ordinary spawns (conversations, builders, A2A) lose one slot on hosts with 4+ slots where the feedback executor runs live and owns the queue: with `maxRerouted` 8 they get 6 instead of 7. Every other agent keeps exactly its old limits, because the reserve is off until the executor turns it on, and an unreadable switch reserves nothing. The slot is idle when the executor is not running, which costs ordinary traffic one session of headroom at peak. Under `auto` mode an ordinary spawn refused here falls back to the headless lane as before; under `force` it is refused and its caller retries, as at any full cap.

## 2. Under-block
The reserve is one slot; the executor runs up to 2 at once, so its second attempt can still be refused (handled by the existing refusal path: stopped, start refunded). Confined spawns are only the feedback executor's canary and build sessions (the only `confinement` callers), so no other caller can take this slot by asking.

## 3. Level-of-abstraction fit
Right layer: the cap lives in `SessionManager`, and the scheduler reserve already uses the same split. The executor's admission pre-check reads the same function, so its "saturated" answer matches what the gate will do.

## 4. Signal vs authority compliance
No new authority: the existing gate keeps its authority and only its partition changes, with deterministic arithmetic (`docs/signal-vs-authority.md`).

## 5. Interactions
`confinedRerouteCapacity()` now answers with the confined cap (`max − 1`), which is what the confined spawn gate uses; before, both used `max − 1` too, so a confined spawn's own limit is unchanged — what changes is that ordinary traffic stops one slot earlier. Scheduler jobs are unaffected. The memory-pressure gate runs first for every kind, as before.

## 6. External surfaces
Only the one machine that owns the feedback queue, with the executor live (dev-gated `feedbackFactory.execute`, not dry-run), with `subscriptionPath.mode: force` and `maxRerouted ≥ 4` changes: one slot less for ordinary spawns. Fleet agents, standby machines of a multi-machine agent, and agents with the executor off or in dry-run keep their old limits. Defaults (`maxRerouted` 3) are unchanged.

## 7. Multi-machine posture
Machine-local by design: each machine bounds its own rerouted sessions against its own memory.

## 8. Rollback cost
Revert and release. No state, config or data migration.

## Second-pass review
**Reviewer:** independent general-purpose subagent, 2026-11-12, given the code rather than my conclusion. Pass 1 concern: the reserve switch left out queue ownership, so on a multi-machine agent every standby machine (where the executor builds but never starts sessions) gave up an ordinary slot for nothing, and §1/§6 overstated the scope. Changed: the switch now also requires `isCanonicalOwner()`, a wiring test covers a standby machine (no reserve), and §1/§6 name the owner machine only. Pass 1 also confirmed: the kind derivation (scheduler first, then confinement), that only the executor passes `confinement`, that the capacity check and the gate agree, small-host and default behaviour, the safe direction of the try/catch, and the `auto` fallback. Pass 2: Concur.
