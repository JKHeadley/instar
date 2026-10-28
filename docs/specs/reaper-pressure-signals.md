---
title: "SessionReaper pressure: measure CPU the way we already tell ourselves to, and notice compressor thrash"
slug: "reaper-pressure-signals"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol — the reaper read the 1-min load average (the symbol) as proof the CPU was saturated (the state); three memory symbols were likewise measured against the state and rejected. See also Structure beats Willpower: the rule 'never judge load from the load average' lived in prose everywhere except the code that decides."
eli16-overview: "reaper-pressure-signals.eli16.md"
status: "converged"
approved: true
parent-spec: "docs/specs/macos-memory-pressure-metric.md (the sibling fix that made freePct an AVAILABLE-memory reading; this adds the signal that reading still cannot see)"
review-convergence: "2026-10-26T06:59:05.835Z"
review-iterations: 2
review-completed-at: "2026-10-26T06:59:05.835Z"
review-report: "docs/specs/reports/reaper-pressure-signals-convergence.md"
---

## 1. What was measured

2026-10-25 ~20:00 PDT, Justin's laptop (`justins-macbook-pro`, 16 cores, 128 GB), while
`ai-guy` was effectively unresponsive to its operator.

`GET /sessions/reaper` reported:

```
tier: critical
inputs: { freePct: 42.8, loadPerCore: 9.4, memTier: normal, cpuTier: critical }
```

`top -l 3 -n 0` on the same machine, seconds later:

```
CPU usage: 36.75% user, 26.88% sys, 36.36% idle
CPU usage: 33.80% user, 26.84% sys, 40.70% idle
CPU usage: 31.29% user, 24.11% sys, 44.59% idle
PhysMem: 115G used (7536M wired, 35G compressor), 12G unused
```

and `ps -A | wc -l` → 1,461 processes, `ps -M -A | wc -l` → 13,698 threads.

## 2. The two findings, which are NOT the same kind of thing

**(a) `cpuTier` is a defect.** `HostPressureSampler.sampleHostPressureInputs()` computes
`loadPerCore = os.loadavg()[0] / cores` and `computePressure` grades `>= 1.5` as `critical`.
What inflated that load average on macOS is not established — its computation is poorly
documented, and the Linux explanation (threads blocked in uninterruptible I/O) is lore here,
not a verified mechanism. What IS measured is the disagreement itself: the machine
held 13,698 threads and read `loadPerCore: 9.4` with **36-44% of its CPU idle**. Which threads
inflated the average is a hypothesis; that the average and the idle figure disagreed is the
observation, and the disagreement is the defect.

This is not a subtle misreading. instar's own agent instructions say, in bold:

> **NEVER** judge load from `uptime` 1-min load average — spike-prone AND on macOS inflated
> by threads stuck in disk I/O.

and `.instar/scripts/load-assess.sh` exists solely so an agent does not do this. The reaper
does exactly the thing the agent is forbidden to do. A rule enforced only in prose is a wish
(Structure > Willpower); this moves it into the sampler.

**Known limits of busy %, named rather than implied away.** It saturates at 100, so it
cannot distinguish 1.1x from 10x oversubscription — acceptable for a three-way tier, not for
a magnitude. And on Linux there is a purpose-built interface that measures STALL time rather
than occupancy (PSI: `/proc/pressure/cpu`, `/proc/pressure/memory`), which is strictly better
where it exists; macOS has no equivalent, so tick-delta busy % is the portable floor chosen
here. PSI is the right thing for CMT-1021's Linux-facing consumers to consider.

**This is a class, not one instance** (review). The same `os.loadavg()[0] / cores` grading also
decides in `src/core/cpuStarvation.ts` (`DEFAULT_MAX_LOAD_RATIO 1.5`, feeding SleepWakeDetector
and the watchdogs), `src/core/MachineLoadBroker.ts` (placement weight),
`src/server/PoolPollCache.ts` (`loadShedPerCore 1.5` — the laptop at 9.4/core serves every pool
view `stale: true`, permanently), `src/core/PoolViewProxy.ts`, and `DegradedTmuxGuard`. This
spec fixes the reaper's reading; the rest of the class is carried by a separate commitment
<!-- tracked: CMT-1021 --> so each consumer is migrated (or its use of load justified) on its
own evidence, with the laptop's stale pool views as the acceptance check.

**(b) `memTier` is NOT reading a wrong number — it is blind to a real signal.** `freePct`
comes from `hostMemoryPressure.ts`, which deliberately reports macOS *available* memory
(free + inactive + purgeable) because `os.freemem()` reads ~0.1% on a healthy Mac and caused
false-criticals (spec `macos-memory-pressure-metric.md`). 42.8% available is a defensible
reading of what that function measures, and this change does not touch it.

What no input could see is that the machine was holding that 42.8% with **35 GB parked in the
compressor**, while ~26% of all CPU time was in `sys` — observed alongside, not proven to be
the compressor's cost (the gate review was right to flag the earlier causal wording).
Compressor strain is the distress signal the reaper had no way to observe. That is a gap, not a
bug, and it is fixed by ADDING an input — never by weakening the existing one.

## 3. The change

### (a) CPU: sample real busy %, from `os.cpus()` ticks

`os.cpus()` already carries per-core cumulative tick counters (`user`, `nice`, `sys`, `idle`,
`irq`). Differencing two snapshots gives the true busy fraction over the interval between
them — no subprocess, no `top`, no 1-minute smear, and it works on macOS and Linux alike.

The sampler keeps the previous snapshot and diffs on each call. The window is NOT "the
caller's tick" — the first draft said so and both external reviews caught that the samplers
are process-wide and `GET /sessions/reaper` consumes the same ones, so a dashboard poll every
second would shrink the reaper's next window to seconds and hand it exactly the burst-prone
reading this change exists to remove. Instead `sampleHostPressureInputs` caches its reading
for `MIN_SAMPLE_WINDOW_MS` (30 s): every caller inside the window gets the same reading (same
`sampledAt`, with `windowMs` reported), and only the passage of time advances the window. The
window is therefore the smoothing: a single hot second cannot by itself grade `critical`,
because the figure is the average over at least 30 s. The FIRST sample after boot has no
previous snapshot and yields `null`.

One `vm_stat` read per sample: `freePct`, `compressorPct` and the decompression rate are all
derived from the same `SystemMemoryReading` — not three independent 5-second-timeout spawns
that could block the loop three times over and disagree with each other (both reviews).

`cpuBusyPct: null` means **cpu unknown ⇒ memory-only**, which is already `computePressure`'s
documented behaviour for `loadPerCore: null`. It deliberately does NOT fall back to the load
average: falling back to a signal we have just proven wrong would re-introduce the defect at
exactly the moment the better signal is missing.

`loadPerCore` is still sampled and still reported in `inputs`, because it is useful context
when reading an audit row — it is simply no longer the thing that decides `cpuTier`.

Thresholds, configurable, defaulting to `cpuModerateBusyPct: 75`, `cpuCriticalBusyPct: 90`.
Rollback lever: `monitoring.sessionReaper.cpuSignal: 'load'` restores the previous behaviour
exactly (`'busy'` is the default).

### (b) Memory: the compressor readings are REPORTED and grade NOTHING — withdrawn, with the measurement that withdrew it

This section is the honest remains of three attempts to build a memory signal. Each one was
measured against real machines in review, and each failed:

1. **Occupancy threshold.** A healthy Mac Studio reads **35.3%** compressor occupancy. The
   2026-10-25 laptop read ~27%. The healthy machine is *higher*.
2. **Occupancy AND decompression activity.** That same healthy Studio runs at **10,660 to
   94,090 decompressions per second**, three orders of magnitude above the bar I had set.
3. **The kernel's own verdict** (`kern.memorystatus_vm_pressure_level`). Corroborated as real
   — `dispatch/source.h` defines NORMAL/WARN/CRITICAL as 0x01/0x02/0x04, and the healthy
   Studio reads 1. But the continuous quantity behind it, `kern.memorystatus_level`, measures
   approximately `(phys − wired − compressor) / phys`: it reads **59 on the healthy Studio**,
   while the 2026-10-25 laptop computes to **≈67**. The laptop scores *better*. The kernel
   would have graded that night `normal`.

So: **every candidate memory signal says that laptop's memory was fine.** The 35 GB in the
compressor was real, and so was the agent that could not start a session — but no memory
instrument available to us distinguishes those two facts from a healthy machine. My premise
("35 GB compressed means memory was strained") was an inference of mine, and three
measurements contradict it.

Therefore this spec ships **no memory grade at all**. `compressorPct`,
`decompressionsPerSec` and `kernelMemoryPressureLevel` are READ (one `vm_stat` + one
`sysctl` already in the sample) and REPORTED on `pressure.inputs`, where they grade nothing
and raise nothing. `memTier` is the available-memory tier, byte-identical to before.

**Why report them at all, rather than nothing?** Because the next attempt needs data from a
machine in the failing state, and a reading costs one sysctl we already make. They are
evidence, explicitly not a verdict.

**Why not ship the kernel grade dark anyway?** A dark signal that review has already shown
would not fire on the incident it was built for is worse than none: it reads as "the memory
gap is handled" in every surface that lists it, and its graduation criterion is structurally
unable to detect a false negative (a week of dark data cannot distinguish "no strain
occurred" from "strain occurred and the level never moved"). "A Dark Feature Guards Nothing"
cuts both ways — the honest move is to say the gap is OPEN.

**What the evidence actually points at.** The laptop had 1,461 processes, 13,698 threads and
112 tmux sessions, its event loop drifted 8-19 s, and job sessions "Died DURING STARTUP" —
while CPU was 36-44% idle and every memory reading said normal. That is the signature of
process/thread crowding and scheduler contention, not of a memory shortage. The right
instrument is therefore a process-footprint measurement, which is a separate tracked work
item (CMT-1016 task 3), not a compressor threshold.
<!-- tracked: CMT-1021 -->

## 4. Safety invariants (each a named test)

1. **The measured case does not grade critical on CPU.** 36-44% idle ⇒ `cpuTier: normal`,
   even with `loadPerCore: 9.4` present in the same inputs.
2. **A genuinely pegged CPU still grades critical.** 95% busy ⇒ `cpuTier: critical`.
3. **Unknown CPU is memory-only.** `cpuBusyPct: null` ⇒ `cpuTier: normal` and the overall
   tier comes from memory alone — and it does NOT silently consult `loadPerCore`.
4. **No compressor reading can change `memTier`.** Not occupancy, not the decompression
   rate, not the kernel level, in any combination and at any value — `memTier` is the
   available-memory tier, full stop. Asserted by sweeping extreme values through
   `computePressure` and checking the tier never moves. This is the invariant that makes the
   withdrawal real rather than a wording change.
5. **Unmeasurable is `null`, never a flattering zero.** A `vm_stat` without the compressor
   or decompressions label yields `null` for that field, not 0; a failed or non-macOS
   `sysctl`, or any value outside {1,2,4}, yields `kernelMemoryPressureLevel: null`. Since
   none of them grades anything, a null costs no decision — but a fabricated 0 would be a
   lie in the evidence this spec exists to collect.
6. **The tick-differencing sampler reports null exactly once.** First call `null`, second
   call a finite 0-100 number; a non-monotonic or zero-delta snapshot yields `null` rather
   than a divide-by-zero or a fabricated 0%.
7. **The rollback lever restores the old grading.** `cpuSignal: 'load'` reproduces the
   2026-10-25 reading (`loadPerCore: 9.4 ⇒ critical`) exactly — the grading, not the payload,
   which carries the new reported fields in either mode.
8. **The 30 s minimum window is the burst defence and is shared by every caller.** A caller
   inside the window gets the identical cached reading (same `sampledAt`); only time advances
   it, so an observability poll can never narrow a decision consumer's window
   (`tests/unit/host-pressure-sampler.test.ts`). One `vm_stat` and one `sysctl` per window.
9. **A CPU figure is published only once a full window has elapsed.** The sampler takes its
   tick BASELINE at construction, but a window shorter than `MIN_SAMPLE_WINDOW_MS` reports
   `null` — unknown, i.e. memory-only per invariant 3. Priming establishes the baseline and
   nothing more. Both round-2 reviewers found the alternative independently: a reading taken
   milliseconds after module load, during process startup, then cached 30 s for every
   decision consumer, is precisely the false `critical` this change exists to remove. The
   cost is accepted and named: for the first ~30 s of a server's life the CPU tier is
   unknown and the tier comes from memory alone.

## 5. Why this matters beyond tidiness

The reaper is the component whose whole job is to notice a machine in trouble and act. On the
night it was most needed its verdict was `critical` for the wrong reason — a CPU phantom —
while its memory input read `normal` on a machine holding 35 GB compressed — a reading that
cannot SEE that state, whether or not the state amounted to strain. A watcher reading
the wrong dial is worse than no watcher: its verdict cannot be trusted either way, and its
memory silence read as an all-clear. Why the reaper's `critical` verdict did not translate
into relief that night is NOT explained by this evidence (its kill path has its own gates),
and this spec does not claim it is; it fixes what the reaper believes, not what it does.

## 6. Testing

- **Unit** (`tests/unit/reaper-pressure-signals.test.ts`): invariants 1-9, plus the exact
  2026-10-25 input vector as a named regression case.
- **Unit** (`tests/unit/host-cpu-busy-sampler.test.ts`): the tick-differencing sampler against
  injected `os.cpus()` snapshots — first-call null, steady-state arithmetic, counter reset.
  The decompression-rate sampler is covered the same way in `reaper-pressure-signals.test.ts`.
- **Unit** (`tests/unit/host-pressure-sampler.test.ts`): one memory read per sample; the 30 s
  cached window shared by every caller (a 1 s poll for 29 s returns the identical reading);
  the primed CPU sampler; a throwing reader yields unknowns.
- **Integration**: `GET /sessions/reaper` reports `cpuBusyPct`, `compressorPct`,
  `decompressionsPerSec`, `kernelMemoryPressureLevel` and `cpuSignal` in `pressure.inputs`
  alongside the existing ones — the three compressor fields as observability, grading nothing.
  NOT asserted at this tier: `sampledAt` / `windowMs`. `sampleHostPressure` adds them and
  `computePressure` does not, and the route tests feed a fixed vector through
  `computePressure`, so they structurally cannot see those two fields; the unit tier
  (`host-pressure-sampler.test.ts`) covers them. Stated rather than implied.
- **Unit (wiring)** (`tests/unit/reaper-pressure-config-wiring.test.ts`): config → the real
  sampler → `computePressure`, so the named rollback lever cannot be silently disconnected —
  the integration and e2e tiers stub the sampler and would stay green without the plumbing.
- **E2E**: the reaper remains alive on the production path and its route still answers 200
  with a pressure reading.

## 7. Rollback

`monitoring.sessionReaper.cpuSignal: 'load'` restores the previous CPU grading. The compressor
no memory grade ships at all, so there is nothing to roll back there. Neither piece writes durable state, so a
revert strands nothing.

## Decision points touched

| Decision point | Class | Justification / floor |
|---|---|---|
| "What is the host's CPU pressure tier?" | **invariant** | A threshold over a measured quantity. The change is WHICH quantity: sampled real busy % instead of the 1-min load average. There are no competing signals to weigh — the load average is not a second opinion about CPU busyness, it is a different quantity (runnable + I/O-blocked threads) that macOS makes a poor proxy. Still reported for observability; decisive only under the rollback lever. |
| "What is the host's memory pressure tier?" | **invariant** | UNCHANGED by this spec: the existing available-memory threshold. Every compressor-based raise was designed, measured and withdrawn (§3b). Monotone by construction: adding a signal can only make the verdict more cautious. |
| "Who may advance the sample window?" | **invariant** | Any caller, but only once ≥30 s have passed since the cached sample; inside the window every caller gets the identical reading. Deterministic by construction; the alternative (per-caller windows) was the first draft's defect. |
| "What does an absent `vm_stat` label mean?" | **invariant** | `null` (unknown), never 0 — the review found the first draft fabricating 0 for a missing label. |
| "Does any compressor reading gate the memory tier?" | **invariant** | NO — withdrawn on measurement (§3b). The memory tier is the available-memory tier; the readings are observability. The alternative (a dark grade) was rejected because review showed it would not fire on the motivating incident and its graduation criterion could not detect that. |
| "What tier when a signal is unmeasurable?" | **invariant** | CPU unknown (first sample, unreadable table) ⇒ `cpuTier: normal`, memory-only — deliberately NOT a fallback to the load average, which would reinstate the defect at the exact moment the better signal is missing. Compressor unknown ⇒ no raise. An unmeasurable value stays `null` on the route, never a fabricated 0. |

## Multi-machine posture

machine-local-justification: hardware-bound-resource

| Surface | Posture | |
|---|---|---|
| The pressure reading | **machine-local** | `hardware-bound-resource` — CPU ticks and compressor pages are facts about one host's hardware; each machine grades its own. |
| `GET /sessions/reaper` `pressure.inputs` | **proxied-on-read (exists)** | The reaper route already carries `?scope=pool`; the new fields ride the same merged read with no change. |

## Verify the state, not its symbol

| | |
|---|---|
| **Symbol** | `cpuBusyPct` — the busy fraction of the interval between two `os.cpus()` snapshots; `kernelMemoryPressureLevel` — `kern.memorystatus_vm_pressure_level`; `compressorPct` — compressor pages ÷ total pages from `vm_stat` (occupancy, observable); `decompressionsPerSec` — the rate of `vm_stat`'s `Decompressions` counter (activity, observable). |
| **Claimed state** | "The CPU is / is not saturated"; "memory is / is not under compressor strain." |
| **Corroboration** | `cpuBusyPct` is the same quantity `top` reports as user+sys and `.instar/scripts/load-assess.sh` already uses as its primary signal; on 2026-10-25 both read 56-64% busy while `loadPerCore` read 9.4. `compressorPct` is the quantity `top`'s `PhysMem … compressor` line reports (35 GB that night). No compressor quantity grades anything: occupancy, the decompression rate and the kernel's own level were each measured against real machines and none separated the strained 2026-10-25 laptop from a healthy one (healthy Studio: 35% occupancy, 94k decompressions/s, pressure level 1, `kern.memorystatus_level` 59 versus the laptop's computed ~67). They are reported as evidence. A pre-upgrade peer's `?scope=pool` snapshot lacks the new fields: absent = unknown, never 0. |
| **Symbol present, state absent?** | A burst inside one window raises the average for that window only; the window is at least 30 s, so a one-second spike cannot grade `critical` alone. Stated honestly: the reaper's existing confirm-across-ticks logic tracks SESSION idleness, not pressure persistence — a hot window can admit an already-idle session to pending, and a later `moderate` window can permit its termination without re-checking the longer idle threshold. That is pre-existing reaper behaviour outside this spec's surface, filed as a found problem (feedback), and NOT claimed here as burst protection. |
| **State present, symbol absent?** | The first tick after boot has no previous snapshot (`null` → memory-only); a counter reset mid-interval yields `null`. Both degrade toward NOT acting, the safe direction for a reaper. |
| **Unmeasurable case** | `cpuBusyPct: null` / `compressorPct: null` on the route — explicit unknown, never 0% or 100%. |

## Frontloaded Decisions

1. **The busy signal is the default; the load average is a rollback lever, not a fallback.**
2. **Thresholds: busy 75/90. No compressor thresholds at all.** Two drafts invented bars on
   occupancy and decompression rate; a measured healthy machine broke both. The compressor
   grade is the kernel's level; the numbers are reported, not judged.
3. **No compressor grade ships.** The available-memory reading is untouched (its own earlier
   fix stands). Three candidate grades were designed and each was withdrawn on measurement
   (§3b); the readings ship as observability so the open question has data next time.
4. **No subprocess for CPU; one `vm_stat` for memory; one cached reading per 30 s window.**
   `os.cpus()` tick deltas, not `top`; every caller — the reaper, the route, the cartographer
   sweep — reads the same cached sample, so no caller can narrow another's window.
5. **The rest of the load-average class is carried, not fixed here** (§2a inventory,
   <!-- tracked: CMT-1021 -->): `cpuStarvation`, `MachineLoadBroker`, `PoolPollCache`,
   `PoolViewProxy`, `DegradedTmuxGuard` each get their own evidence-based migration.

## Maturation plan

- **test-agent-live:** the CPU correction is covered by the unit/integration/e2e tiers plus a
  live `GET /sessions/reaper` read on this machine confirming `cpuTier` tracks
  `load-assess.sh`'s real idle rather than the load average. There is NO memory-signal soak,
  because no memory signal ships; the compressor readings are observability from day one.
- **dev-agent-live:** the CPU correction ships live on the development agent (shipping it
  dark would leave the reaper grading `critical` off a phantom). The compressor readings are
  observability and are live everywhere from day one; the daily
  `(compressorPct, decompressionsPerSec, kernelMemoryPressureLevel)` tuple is recorded on
  CMT-1016 so the open memory question accumulates evidence.
- **fleet:** the CPU correction ships fleet-wide in this release with `cpuSignal: 'load'` as
  the rollback. There is no compressor flag to flip, now or later — a future memory signal
  arrives through its own spec, built on the readings this one starts collecting.
- **graduation criterion:** CPU only — over 7 days on the laptop, on ticks where
  `load-assess.sh` is read over the SAME 30 s window as the reaper's sample (aligned
  intervals, not merely the same minute), `cpuTier` agrees with that independent idle figure:
  no `critical` while idle >= 30%, no `normal` while idle <= 5%. A cross-check against another
  instrument, never the reaper grading its own thresholds. Nothing about the compressor
  readings graduates, because they decide nothing; what they are for is to be ON RECORD the
  next time a machine reaches the 2026-10-25 state, so the open memory question can be
  attacked with data instead of inference.
- **dark-window:** none is required, because nothing in this change decides anything new on
  a dark flag: the CPU correction ships LIVE (it is a correction to a measurement that was
  demonstrably wrong, and its rollback lever is `cpuSignal: 'load'`, tested end to end), and
  the compressor readings are observability with no decision attached. The open memory
  question carries its own future spec rather than a dark flag here.

## Carried work (frozen excerpts)

Inlined so a reviewer can check each carrier below covers what it claims, without API access.
<!-- tracked: CMT-1021 --> Ledger: `docs/specs/carriers/reaper-pressure-signals.json`.

> **CMT-1021** — "Fix the class: the same `os.loadavg()[0]/cores` grading that misread a
> 36-44%-idle laptop as critical also lives in src/core/cpuStarvation.ts
> (DEFAULT_MAX_LOAD_RATIO 1.5 → SleepWakeDetector/watchdogs), src/core/MachineLoadBroker.ts
> (placement weight), src/server/PoolPollCache.ts (loadShedPerCore 1.5 → every pool view
> stale on the laptop), src/core/PoolViewProxy.ts, and DegradedTmuxGuard. Migrate each to the
> sampled real-CPU-busy signal (or justify keeping load where it is the right quantity), one
> spec per consumer or one class spec, with the laptop-stale-pool-views symptom as the
> acceptance check." (status pending, owner agent)

## Open questions

*(none)*
