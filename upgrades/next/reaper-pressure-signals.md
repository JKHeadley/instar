## What Changed

**SessionReaper pressure: real CPU busy % instead of the load average; the memory signal was
designed, measured and withdrawn** (spec `docs/specs/reaper-pressure-signals.md`,
side-effects `upgrades/side-effects/reaper-pressure-signals.md`).

- `computePressure` now grades `cpuTier` from `cpuBusyPct` — sampled real CPU busy % from
  `os.cpus()` tick deltas (`hostCpuBusySampler.ts`) — under the default `cpuSignal: 'busy'`.
  The 1-minute load average is still sampled and reported as `loadPerCore` but no longer
  decides anything: on 2026-10-25 it read 9.4 per core (`critical`) on a laptop whose CPU was
  36-44% idle. An unknown busy sample grades `normal` — memory-only — and deliberately does
  NOT fall back to the load average. `cpuSignal: 'load'` restores the legacy grading exactly,
  and a test drives that lever from a config object through the sampler into the classifier.
- A CPU figure is published only once a full 30 s window has elapsed; a shorter window is
  `null` (unknown), never a startup spike. So for roughly the first 30 s of a server's life
  the tier comes from memory alone — stated, not hidden.
- One `vm_stat` + one `sysctl` per 30 s sample window; every caller (route, reaper,
  cartographer sweep) reads the same frozen cached sample, so a dashboard poll cannot narrow
  the reaper's window.
- **No memory grade ships.** `compressorPct`, `decompressionsPerSec` and
  `kernelMemoryPressureLevel` are REPORTED and decide nothing. Three candidate grades were
  built and each withdrawn on measurement: a healthy Studio reads 35% compressor occupancy
  and 94k decompressions/s at kernel pressure level 1, and the continuous
  `kern.memorystatus_level` reads 59 there while the 2026-10-25 laptop computes to ~67 — every
  candidate said that laptop's memory was fine. The evidence points at process/thread
  crowding instead (CMT-1016 task 3). The readings ship as observability so the next attempt
  starts from data.
- New `monitoring.sessionReaper` keys: `cpuSignal`, `cpuModerateBusyPct` (75),
  `cpuCriticalBusyPct` (90). No compressor key, because no compressor decision ships.
- `GET /sessions/reaper` → `pressure.inputs` gains `cpuBusyPct`, `compressorPct`,
  `decompressionsPerSec`, `kernelMemoryPressureLevel`, `cpuSignal`, `sampledAt`, `windowMs`.
- Migration parity: one exported constant is the single source for the CLAUDE.md bullet, and
  both legacy wordings (the migrator's own and the older template's) are replaced in place on
  every deployed agent.

## What to Tell Your User

The part of me that decides whether a machine is overloaded was reading the wrong dial for
processor load on a Mac: it called a laptop critical while a third of its processors sat idle.
It now reads what the processors actually did, averaged over half a minute. One setting puts
the old reading back if you ever want it.

I also tried to add a memory-pressure reading, and I am telling you plainly that it did not
work: every way I found to measure it scored a perfectly healthy machine as worse than the
struggling one, so I withdrew it rather than ship something that looks like a safeguard and
is not. The readings are recorded now but decide nothing, and the real cause on that laptop
looks like too many programs and sessions open at once, which is a separate piece of work
already on the list.

## Summary of New Capabilities

- `pressure.inputs.cpuBusyPct` / `compressorPct` / `decompressionsPerSec` /
  `kernelMemoryPressureLevel` / `sampledAt` / `windowMs` on `GET /sessions/reaper` (and
  `?scope=pool`) — the three compressor fields as observability, grading nothing.
- `monitoring.sessionReaper.cpuSignal: 'load'` rollback lever, plus the
  `cpuModerateBusyPct` / `cpuCriticalBusyPct` busy thresholds.

## Evidence

- Measured 2026-10-25 ~20:00 PDT on the operator's laptop: reaper `loadPerCore: 9.4 →
  cpuTier: critical`, `freePct: 42.8 → memTier: normal`; `top`: 36-44% idle, 115/128 GB used,
  35 GB compressor.
- Measured in round-2 review on the Mac Studio: 35.3% compressor occupancy, 10,660-94,090
  decompressions/s, `kern.memorystatus_vm_pressure_level` 1, `kern.memorystatus_level` 59 —
  against the laptop's computed ~67. This is what withdrew the memory grade.
- `tests/unit/reaper-pressure-signals.test.ts` carries that exact vector as a named
  regression (busy → `normal`; `cpuSignal: 'load'` → `critical` again) plus a sweep proving no
  compressor value at any magnitude moves `memTier`.
- `tests/unit/host-cpu-busy-sampler.test.ts` covers first-call null, the window floor (a
  measurable delta over a 5 ms window is `null`), counter reset, and a throwing read.
- `tests/unit/host-pressure-sampler.test.ts` covers one memory read per sample, the shared
  30 s window, the frozen cached reading, and unknown-until-a-full-window.
- `tests/unit/reaper-pressure-config-wiring.test.ts` proves the config → sampler → classifier
  path, so the rollback lever cannot be silently disconnected.
- `tests/unit/PostUpdateMigrator-reaperPressureSentence.test.ts` proves deployed agents get
  the corrected awareness text in place, and that a drifted file is left alone.
- `tests/e2e/session-reaper-lifecycle.test.ts` asserts the new fields reach the route through
  the real `AgentServer` plumbing; the integration suite is extended the same way.
