# Scheduled jobs no longer refused on a healthy Mac

## What Changed

`SessionManager.currentMemoryPressure()` now reads real available memory via `hostFreeMemPct()`
(free + inactive + purgeable through `vm_stat` on macOS; `MemAvailable` on Linux) instead of raw
`os.freemem()`.

On macOS `os.freemem()` counts only "Pages free" — **0.46 GB of 17 GB (2.7%)** on a completely healthy
host. The method therefore computed 97% used and returned **`critical` permanently**. Under
`subscriptionPath.mode: 'force'`, `evaluateRerouteGate()` throws on elevated pressure, so **every job
spawn was refused**.

The corrected helper already existed in-package and is used by `SessionReaper` / `HostPressureSampler`;
its comment warns against `os.freemem()` by name. The 2026-06-26 `macos-memory-pressure-metric` fix
converted those two callers and missed this one. **Thresholds (90/75/60) are unchanged — only the
measurement source moved.**

`getSessionDiagnostics()`'s memory block moves to the same source, so the reported percentage and the
reported tier can no longer contradict each other (before, that surface could show "97% used" next to
tier `low`).

Two other `os.freemem()` callsites (`src/server/routes.ts`, `src/monitoring/HealthChecker.ts`) already
prefer `MemoryPressureMonitor`'s `vm_stat` state and fall back only when it is absent — reviewed and
correct as-is, deliberately untouched.

## What to Tell Your User

If your scheduled jobs stopped running and every failure said the machine was out of memory, this is the
fix — and the machine was almost certainly fine the whole time.

On a Mac, the figure being used counted only completely untouched memory. Macs deliberately use spare
memory as cache, so that number sits near zero on a perfectly healthy machine. Your agent read it as
"97% used, critical" and refused to start any scheduled job.

On the machine where this was found, **20 of 27 enabled jobs were dead — the health check and the
commitment tracker had each failed 421 times in a row**, going back more than two days, while the machine
had ample memory free. A second machine with 137 GB of memory and 21 GB genuinely free was being rated
under pressure by the same calculation.

Your agent now reads memory the way the operating system itself reports it. Nothing about *when* it
protects you has changed — a genuinely loaded machine still refuses new work at exactly the same
thresholds. It just no longer believes a healthy machine is full.

You may also notice memory figures in session diagnostics drop substantially on macOS. That is the
correction, not a regression.

## Summary of New Capabilities

No new capabilities — this is a correctness fix to an existing guard. The guard keeps its authority and
its thresholds; only the number it reads is corrected.

## Evidence

- **Live measurement before the fix:** 20 of 27 enabled jobs failing, all with
  `Reroute refused (force-mode): host memory pressure is critical`; `health-check` and
  `commitment-detection` at **421 consecutive failures** each.
- **Three readings of the same machine, same second:** raw `os.freemem()` → 2.7% free → `critical`;
  the reaper's corrected reading → 16.3% free → `normal`; macOS `memory_pressure` → 38% free.
- **Reproduced on a second machine:** 137 GB total, 21 GB genuinely free → raw metric rated it `high`.
- **New tests:** `tests/unit/session-manager-memory-pressure-sibling.test.ts` (6).
  **Control run — 3 of 6 fail against pre-fix code for the right reasons**, including
  `expected [Function] to not throw but 'Error: Reroute refused (force-mode): …' was thrown`, the exact
  production error. The other 3 pass either way **by design**: they pin that a genuinely exhausted host
  still reads `critical` and is still refused, so an "always return low" regression cannot pass.
- **Green:** 48/48 across the new suite plus `host-memory-pressure.test.ts` (16) and
  `headless-spawn-reroute.test.ts` (26). `tsc --noEmit` clean; full lint suite clean.
- **Side-effects review:** `upgrades/side-effects/memory-pressure-metric-sibling.md`.
- **Spec:** `docs/specs/macos-memory-pressure-metric.md` (converged 2026-06-26, approved) — this ships
  the caller that spec's original fix did not convert.
