# Side effects — SessionReaper pressure: measure CPU the way we already tell ourselves to, and notice compressor thrash

Spec: `docs/specs/reaper-pressure-signals.md`
ELI16: `docs/specs/reaper-pressure-signals.eli16.md`

## The change

1. `src/monitoring/hostCpuBusySampler.ts` (new) — real CPU busy % from `os.cpus()` tick
   deltas; first call and any unmeasurable interval yield `null`, never a fabricated number.
2. `src/monitoring/hostMemoryPressure.ts` — `parseVmStat` now also reports
   `compressorPercent` (occupancy), the cumulative `decompressions` counter and the page size,
   compressor occupancy and decompressions each `null` when their label is absent (never 0);
   the page size keeps its existing 16 KiB default rather than going null, because it is a
   constant of the platform, not a measurement; `makeDecompressionRateSampler()` derives a
   per-interval rate on the SHARED sample clock threaded in by its sole production caller,
   `HostPressureSampler` (the clock is a parameter so the 30 s window governs the rate too —
   NOT a per-caller window, which is the defect this replaced);
   `readKernelMemoryPressureLevel()` reads `kern.memorystatus_vm_pressure_level` and maps
   ONLY 1/2/4; any other value, a parse failure, or a non-macOS host is `null` (the sysctl is
   private and undocumented, so an unrecognized value must never be guessed into a tier).
   `hostCompressorPct()` is retained as a helper but production derives everything from the
   one shared reading.
3. `src/monitoring/SessionReaper.ts` — `computePressure` takes `cpuBusyPct` and reports the
   three compressor observables. Under `cpuSignal: 'busy'` (default) `cpuTier` comes from
   busy %; unknown ⇒ `normal` (memory-only), deliberately not a fallback to the load average.
   `cpuSignal: 'load'` reproduces the legacy GRADING exactly. **`memTier` is UNCHANGED by
   this spec**: no compressor quantity grades anything. Three candidate grades (occupancy;
   occupancy AND decompression rate; the kernel's own `kern.memorystatus_vm_pressure_level`)
   were each measured against real machines in review and each withdrawn — a healthy Studio
   reads 35% occupancy and 94k decompressions/s at pressure level 1, and the continuous
   `kern.memorystatus_level` reads 59 there while the 2026-10-25 laptop computes to ~67, so
   no candidate separated the strained machine from the healthy one. `loadPerCore` is still
   sampled and reported.
4. `src/monitoring/HostPressureSampler.ts` — ONE `vm_stat` + ONE `sysctl` per sample feeding
   freePct, compressorPct, the decompression rate and the kernel level; the reading is CACHED
   for `MIN_SAMPLE_WINDOW_MS` (30 s) so the route, the reaper and the cartographer sweep all
   read the same sample and no poll can narrow another consumer's rate window (`sampledAt` /
   `windowMs` reported). The CPU sampler's baseline is primed at construction but publishes
   `null` until a full window has elapsed — a window of milliseconds at process startup is a
   spike, not an average (both round-2 reviewers).
5. `src/core/types.ts` — `monitoring.sessionReaper.{cpuSignal, cpuModerateBusyPct,
   cpuCriticalBusyPct}`. No compressor key is added, because no compressor decision ships.
6. `src/commands/server.ts` — the three `sampleHostPressure` call sites pass the new config.
7. Awareness: ONE exported constant (`REAPER_PRESSURE_BULLET` in `templates.ts`) is the
   single source for both `generateClaudeMd()` and `PostUpdateMigrator.ts`, which installs it
   for agents without the section AND replaces BOTH legacy wordings in place — the migrator's
   own old sentence and the older template's bullet. Round-2 review caught that keying on the
   migrator's wording alone left every template-initialized agent unpatched; an
   operator-rewritten sentence matches neither form and is skipped, not clobbered.

## 1. Over-block — what does this now grade as pressure that it shouldn't?

A genuinely busy CPU still grades as busy — 95% is critical, 80% moderate (tested). The
busy figure is an average over at least a 30 s window (shorter ⇒ `null`, memory-only), so
neither a one-second spike nor a startup flicker can grade `critical`; what the reaper does
with a hot window is its existing behaviour. Nothing on the memory side can over-block,
because nothing on the memory side changed: the compressor readings grade nothing, asserted
by sweeping extreme values through `computePressure` and checking `memTier` never moves.

**Not identified as an issue:** over-reaping. The change only ever REMOVES a false
`critical` (the load-average phantom) and adds no new path to any tier — the memory side is
untouched and the three new readings are inert.

## 2. Under-block — what does this still miss?

- For the first full window (~30 s) of a server's life the CPU tier is unknown ⇒ memory-only.
  Accepted and named: less aggressive is the safe direction, and the alternative is publishing
  a startup spike.
- **The memory gap is OPEN and this change does not close it.** Three candidate signals were
  measured and withdrawn (§3b); what the 2026-10-25 evidence actually points at is process /
  thread crowding (1,461 processes, 13,698 threads, 112 sessions, 8-19 s event-loop drift at
  36-44% CPU idle), which is CMT-1016 task 3, not a compressor threshold. The readings ship
  as observability so the next attempt has data from a failing machine.
- Compressor readings are macOS-only; on Linux they report `null`.
- `PoolViewProxy` / `PoolPollCache` load-shedding keeps its own load-per-core knob — a read-side
  shed with its own precedent, out of scope and noted in the spec.
- Thermal / disk-I/O pressure: not measured, as before (`load-assess.sh` says the same).
- **The rest of the load-average class**: `cpuStarvation.ts`, `MachineLoadBroker.ts`,
  `PoolPollCache.ts`, `PoolViewProxy.ts`, `DegradedTmuxGuard` still grade on
  `loadavg/cores`; the laptop's pool views are permanently `stale` for the same reason.
  Carried by CMT-1021, not fixed here.

## 3. Level-of-abstraction fit

The quantity lives where the quantity is read: the sampler in `HostPressureSampler` (the one
definition of "host pressure" that the reaper and the cartographer sweep already share), the
grading in `computePressure` (the single source of truth for the tier). No new component, no
new authority.

## 4. Signal vs authority

`computePressure` already holds the reaper's pressure authority; this changes its inputs to
measured ones. Deterministic thresholds over measured quantities — nothing brittle is given new
authority, and the LLM is nowhere near it.

## 5. Interactions

- **SessionReaper** reads a more honest tier; the kill logic is unchanged.
- **ResumeQueueDrainer's "machine calm" gate** reads the same tier — a phantom `critical` was
  also blocking revival; that clears too.
- **CartographerSweepPoller** shares `sampleHostPressure` and benefits identically.
- **SleepWakeDetector / load-assess.sh** are untouched; they already used real idle.
- **Shared samplers, cached**: every caller inside a 30 s window gets the identical reading.
  A dashboard poll cannot shrink the reaper's window (both external reviews flagged the
  uncached first draft). `GET /sessions/reaper` therefore reports a figure up to 30 s old,
  stamped `sampledAt`.
- **The 30 s shared cache**: the reaper ticks on the order of minutes and
  `ResumeQueueDrainer` on 60 s with 3 calm ticks, both wider than the window, so no consumer
  loses independence; the cached reading is frozen so one consumer cannot mutate another's.
- **Reaper kill-path semantics are unchanged and NOT claimed as burst protection**: its
  confirm-across-ticks logic tracks session idleness, not pressure persistence — a found
  problem filed to feedback, outside this spec.

## 6. External surfaces

- `GET /sessions/reaper` → `pressure.inputs` gains `cpuBusyPct`, `compressorPct`,
  `decompressionsPerSec`, `kernelMemoryPressureLevel`, `cpuSignal`, `sampledAt`, `windowMs`.
  No new route. `?scope=pool` carries them unchanged; a
  pre-upgrade peer's snapshot lacks them (absent = unknown).
- Config keys above; absent keys yield the shipped defaults (no migration needed).
- Awareness text updated in both template and migrator (same sentence, both sides).

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local, `hardware-bound-resource`** — CPU ticks and compressor pages are facts about
one host; each machine grades its own. The route's `pressure` is already proxied-on-read via
the existing `?scope=pool`. No durable state; no notice; no URL.

## 8. Rollback cost

`monitoring.sessionReaper.cpuSignal: 'load'` restores the previous CPU grading exactly
(tested against the 2026-10-25 vector, AND tested end-to-end from a config object through the
sampler into the classifier, so the lever is proven connected rather than merely named).
There is no memory rollback because there is no memory change. No durable state is written.

## Second-pass review

Required: the reaper is the component that kills sessions, and this changes what it believes
about the machine. Review response appended by the convergence round.
