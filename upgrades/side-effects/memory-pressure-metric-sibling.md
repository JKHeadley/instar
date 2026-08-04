# Side-effects review — macos-memory-pressure-metric SIBLING (SessionManager)

**Change:** `SessionManager.currentMemoryPressure()` and `getSessionDiagnostics()`'s memory block now read
the corrected available-memory figure via `hostFreeMemPct()` instead of raw `os.freemem()`.
**Spec:** `docs/specs/macos-memory-pressure-metric.md` (converged 2026-06-26, `approved: true`) — this is
the caller that spec's original fix did not convert.
**Author:** echo · **Date:** 2026-08-04
**Sanction:** architect review 2026-08-04, under Justin's plan-scoped approval of 2026-08-03 20:21 PDT
(relayed 20:23). Escalated to Phase A critical path because it starves the grading job that answers rung 3.

## What was wrong

`os.freemem()` on macOS counts only "Pages free". On a healthy 17 GB Mini it reports **0.46 GB (2.7%)**,
so `currentMemoryPressure()` computed 97% used and returned **`critical` permanently**. Under
`subscriptionPath.mode: 'force'`, `evaluateRerouteGate()` **throws** on elevated pressure — so every job
spawn was refused.

**Measured on the live host before the fix:**
- 20 of 27 enabled jobs failing, all with `Reroute refused (force-mode): host memory pressure is critical`
- `health-check` and `commitment-detection` at **421 consecutive failures** each, going back ≥2 days
- three readings of the same machine, same second: **raw 2.7% free → `critical`** · reaper (corrected)
  **16.3% free → `normal`** · macOS `memory_pressure` **38% free**
- the same defect on the laptop: **137 GB RAM, 21 GB genuinely free → raw metric says `high`**

The corrected helper already existed in-package (`hostFreeMemPct`, used by
`HostPressureSampler`/`SessionReaper`) and its shipped comment warns against `os.freemem()` **by name**.
The reaper was fixed; this caller was not.

## The 8 questions

**1. Over-block — what legitimate inputs does this reject that it shouldn't?**
None introduced; this change *removes* an over-block. Pre-fix the gate rejected **every** force-mode spawn
on macOS regardless of real conditions. Post-fix it rejects only genuinely elevated hosts. Thresholds
(90/75/60) are byte-identical — only the measurement source moved.

**2. Under-block — what failure modes does this still miss?**
The gate now trusts `hostFreeMemPct`, so it inherits that helper's limits: on an unrecognised platform it
falls back to `os.freemem()`-equivalent behaviour, and `vm_stat` parse failure degrades to the same. That
is the pre-existing, already-reviewed behaviour of the 2026-06-26 fix, not new exposure. **Genuinely
exhausted hosts still read `critical` — covered by a dedicated test so a "just return low" regression
cannot pass.**

**3. Level-of-abstraction fit.**
Correct layer. `currentMemoryPressure()` is the single definition of the pressure tier shared by the
reroute gate and the diagnostics surface (deliberately extracted in june15-headless-spawn-reroute PR2/O2).
Fixing it here fixes both consumers at once. The alternative — patching each caller — is what produced
this sibling in the first place.

**4. Signal vs authority compliance.** (`docs/signal-vs-authority.md`)
**Compliant, and it is the point of the change.** `currentMemoryPressure()` is a **detector**: it produces
a signal (`MemoryPressure` tier). `evaluateRerouteGate()` is the **authority** that decides. The defect was
a detector emitting a *false signal* to a correct authority. This change corrects the detector's
measurement and **adds no authority, moves no authority, and changes no threshold**. No new blocking logic
is introduced anywhere.

**5. Interactions — shadowing, double-fire, races.**
Two other `os.freemem()` callsites exist (`src/server/routes.ts:3743`, `src/monitoring/HealthChecker.ts:217`).
**Both were inspected and both already compensate** — each prefers `MemoryPressureMonitor`'s vm_stat-based
state and only falls back to `os.freemem()` when the monitor is absent, with a comment saying why. They are
correct as-is and are deliberately **not** touched. No shadowing: the reroute gate is the only consumer of
the tier for spawn decisions, and the diagnostics surface is read-only.

⚠️ **Interaction worth naming:** `tests/unit/headless-spawn-reroute.test.ts` **stubs `currentMemoryPressure`
to `'normal'`**, with the comment that the real gate *"made this suite fail on loaded dev machines."* It was
not a loaded dev machine — **it was this defect, encountered, rationalised, and stubbed over**, which is why
CI never caught it. The stub is left in place (those tests assert reroute control-flow, not pressure) but
the new suite exercises the real method so it can now fail for the real reason.

**6. External surfaces.**
`getSessionDiagnostics()` payload changes: `usedPercent` and `freeMemMB` now report real available memory.
On macOS these numbers will **drop substantially** (e.g. 97% → ~40% used) — that is the correction, not a
regression. Pre-fix, once the tier was fixed alone, the surface could have reported **"97% used" beside tier
`low`**; both now read one source and a test pins that they cannot contradict. No timing or conversation-state
dependence.

**7. Multi-machine posture (Cross-Machine Coherence).**
**Machine-local BY DESIGN — correctly so.** Host memory pressure is a property of the physical machine; a
reading must never be replicated or proxied from a peer. Verified the defect independently on **both**
machines (Mini: raw `critical` vs corrected `normal`; laptop: raw `high` vs corrected `normal` with 21 GB
free). The fix therefore lands on both, and each machine keeps reading its own memory. No replication path,
no merged read, no cross-machine state. **This also removes a latent block on the ratified placement policy:**
worker lanes are to run on the laptop, and the same gate would have refused spawns there too.

**8. Rollback cost.**
Trivial. Revert the commit — no data migration, no agent-state repair, no persisted format change. The
change is confined to two computations inside one file plus one new test file. A hot-fix release restores
prior behaviour exactly (including, if anyone wants it, the permanent-`critical` bug).

## Testing

New: `tests/unit/session-manager-memory-pressure-sibling.test.ts` (6 tests).

**Control run — 3 of 6 fail against pre-fix code, each for the right reason** (verified by stashing the
source change and re-running):
- `expected 'critical' not to be 'critical'` — the defect itself
- `expected [Function] to not throw but 'Error: Reroute refused (force-mode): …' was thrown` — **the exact
  production error that killed 20 jobs**
- `expected 'critical' to be 'high'` — the Linux threshold path also mis-tiered

The other 3 pass either way **by design** — they are the guards proving the fix does not simply always
return `low` (genuinely-exhausted host still `critical`; gate still refuses it; diagnostics self-consistent).

Green: 48/48 across the new suite + `host-memory-pressure.test.ts` (16) + `headless-spawn-reroute.test.ts`
(26). `tsc --noEmit` clean.

## Second-pass review

Required (touches a **gate**). See appended section below.
