# Convergence report — reaper-pressure-signals

Spec: `docs/specs/reaper-pressure-signals.md` · ELI16: `docs/specs/reaper-pressure-signals.eli16.md`
Side-effects: `upgrades/side-effects/reaper-pressure-signals.md`
Author: echo · Rounds: 2 · Verdict: **CONVERGED**

## The one-line story

The spec started as two fixes to the session reaper's two pressure readings. It ends as **one
fix and one documented failure**: the CPU correction is built and shipping, and the memory
signal was designed three different ways, measured against real machines in review, and
withdrawn — because every candidate graded a healthy machine worse than the struggling one.

## Iteration summary

| Round | Standards-Conformance Gate | External reads | Internal lenses | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | ran (flags addressed in-round) | codex `gpt-6-astra` (crossFamily), claude `claude-fable-5` (clean-door) | six lenses | 6 DESIGN / 9 PRECISION | not converged — compressor thresholds unmeasured |
| 2 | ran (**0 flags**) | codex `gpt-6-astra` → SERIOUS ISSUES, claude `claude-fable-5` → MINOR ISSUES | six lenses (7 DESIGN / 12 PRECISION) | 11 DESIGN / 21 PRECISION across all reviewers | **converged** — memory grade withdrawn on measurement |

## What round 1 changed

1. The shared sampler and the live status route were sharing one measuring window, so a
   dashboard refresh could shrink the window the reaper's decision relied on → one cached
   reading per 30 s, shared by every caller.
2. One sample was spawning `vm_stat` three times → one read per sample.
3. The claim that the reaper's confirm-across-ticks logic gave burst protection was false (it
   tracks session idleness, not pressure persistence) → claim removed, filed as feedback.
4. Hand-set compressor thresholds (20%/35%/50-per-second) → replaced by the kernel's own
   pressure level, after a healthy machine measured 35.3% occupancy and 10,660-94,090
   decompressions/s at pressure level 1.
5. `parseVmStat` fabricated `0` for an absent label → `null`.
6. The decompression-rate sampler used the wall clock, not the sample clock → clock threaded
   through (the listed unit test was failing because of it).
7. The load-average misgrading was named as one instance; it is a CLASS (`cpuStarvation.ts`,
   `MachineLoadBroker.ts`, `PoolPollCache.ts`, `PoolViewProxy.ts`, `DegradedTmuxGuard`) →
   inventory stated, carried by CMT-1021.
8. The CLAUDE.md awareness text reached only fresh agents → in-place migration added.

## What round 2 changed — including the decision to withdraw

**The finding that settled it.** `kern.memorystatus_vm_pressure_level` is real (corroborated
against `dispatch/source.h`: NORMAL/WARN/CRITICAL = 0x01/0x02/0x04), but the continuous
quantity behind it, `kern.memorystatus_level`, measures approximately
`(phys − wired − compressor) / phys`. Measured: **59 on the healthy Mac Studio**, while the
2026-10-25 laptop computes to **≈67**. The laptop scores better. The kernel would have graded
that night `normal` — so the replacement grade would not have fired on the incident it was
built for, and its graduation criterion ("every raise coincided with level ≥ 2") was
structurally unable to detect that false negative.

Two independent reviewers also converged on the same startup hole: priming the CPU sampler at
module load gave the first sample a window of milliseconds at the churniest moment, and the
30 s cache then served that spike to every decision consumer.

Resolutions:

| Finding | Resolution |
|---|---|
| Kernel grade would not fire on the motivating incident | **Memory grade withdrawn entirely.** The three readings are reported and decide nothing. Invariant 4 asserts no compressor value at any magnitude moves `memTier`. |
| `compressorTier` collapsed unmeasurable into the flattering `normal` | Moot — the tier no longer exists. |
| Startup window of milliseconds published as an average | A CPU figure requires a full `MIN_SAMPLE_WINDOW_MS` window; shorter is `null` (memory-only). Priming is baseline-only. Named cost: no CPU tier for ~30 s after boot. |
| Migration reached only migrator-sourced agents | ONE exported constant (`REAPER_PRESSURE_BULLET`) shared by template and migrator; BOTH legacy wordings replaced in place; drifted files skipped. |
| `{ ...DEFAULTS, ...thresholds }` tripped the undefined-erasing-merge lint | `mergeDefaults(...)`. |
| The named rollback lever was unproven — integration/e2e stub the sampler, so deleting the config plumbing broke nothing | `tests/unit/reaper-pressure-config-wiring.test.ts`: config → sampler → classifier, plus a source assertion that every `sampleHostPressure` callsite passes the three keys. |
| The window-floor test could only pass by luck (clock injected, ticks not) | `readCpus` seam added to the test seam. |
| Decision-point table still described the withdrawn design | Rewritten. |
| Cached reading handed out by reference | `Object.freeze`, with a test. |
| Two cannot-fail assertions in a touched test file | One replaced by a real delegation check over the shared cached reading; the other made a range check. |
| Mechanism claims exceeded the evidence ("macOS load average counts I/O-blocked threads"; "memory was actually strained"; ELI16 asserting disk waiting as fact) | Softened to the measured disagreement in spec, ELI16, artifact, release note, and both source headers. |
| ELI16 said "on Linux nothing changes" | Corrected — the CPU fix applies on Linux; only the compressor readings are macOS-only. |
| PSI (`/proc/pressure/*`) unacknowledged as the better Linux interface; busy % saturates at 100 | Both limits named in §3a and pointed at CMT-1021's Linux consumers. |
| The private sysctl could be guessed into a tier if Apple changes it | Only {1,2,4} map; anything else is `null`. |

## Why withdrawal rather than shipping dark

"A Dark Feature Guards Nothing" was the argument for shipping it dark; it is also the argument
against. A dark signal that review has already shown would not fire on its motivating incident
still reads as "the memory gap is handled" in every surface that lists it, and its soak could
not have told "no strain occurred" from "strain occurred and the level never moved". The gap is
recorded as OPEN, the readings ship as evidence, and §3b points the question at process/thread
crowding — which is what the 2026-10-25 numbers actually describe (1,461 processes, 13,698
threads, 112 sessions, 8-19 s event-loop drift, at 36-44% CPU idle).

## Honest residue

- **The memory gap is open.** This change does not detect the 2026-10-25 memory state, and
  says so in the spec, the artifact, the release note and the ELI16.
- **Where levels 2 and 4 actually trip is unverifiable from here** — which is why nothing
  depends on them.
- **The load-average class is not fixed**, only inventoried (CMT-1021).
- **`reaper-pressure-signals.test.ts` can only test the stub of the kernel read**, never
  macOS's real level semantics.

## Standards engaged

Structure > Willpower (the rule moves from prose into the sampler) · Verify the State, Not Its
Symbol (three symbols rejected for failing to prove the state) · A Dark Feature Guards Nothing
(read in both directions) · Migration Parity · Deferral = Deletion (CMT-1021, CMT-1016) ·
Judgment Within Floors (every decision point classified) · Fix the Class, Not the Instance
(class inventoried rather than silently narrowed).
