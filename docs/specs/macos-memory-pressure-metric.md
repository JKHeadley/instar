---
title: "macOS memory-pressure metric — read real available memory, not os.freemem"
slug: "macos-memory-pressure-metric"
author: "echo"
eli16-overview: "macos-memory-pressure-metric.eli16.md"
parent-principle: "No Silent Degradation to Brittle Fallback"
review-convergence: "2026-06-26T20:03:20.433Z"
review-iterations: 2
review-completed-at: "2026-06-26T20:03:20.433Z"
review-report: "docs/specs/reports/macos-memory-pressure-metric-convergence.md"
cross-model-review: "skipped-abbreviated"
approved: true
approved-by: "echo (under Justin's standing blanket authority, topic 28130/28744 — live load-measurement incident, his explicit top priority)"
approved-basis: "standing-authorization + explicit directive (the load-measurement issue is top priority); conformance gate + lessons-aware reviewer ran (no blockers; parser-realness + observability findings resolved); the change can only relax the reaper + free revival on macOS (safe direction), reuses the byte-identical proven vm_stat calc, 13 tests incl real fixtures + 121 existing green"
cross-model-review-reason: "live incident fix (topic 28744 not responding); conformance gate + lessons-aware reviewer ran, parser-realness + observability findings resolved, no blockers"
---

# macOS memory-pressure metric — read real available memory, not os.freemem

## Problem statement

The SessionReaper's memory-pressure tier is computed from `freePct = os.freemem() / os.totalmem() * 100` (in `HostPressureSampler.sampleHostPressureInputs`). On macOS, `os.freemem()` returns ONLY "Pages free" — which macOS deliberately keeps near-zero (it uses the rest for cache / compressor / purgeable). So on a healthy 128GB machine `os.freemem()` reads ~0.1-0.4%, and `freePct < MEM_CRITICAL_FREE_PCT (5)` → `memTier: 'critical'` **permanently**, while the machine's REAL available memory is ~20-40%.

Two fleet-wide failures result, both observed live (2026-06-26, topic 28744):
1. **Over-reaping:** the SessionReaper takes the WORST of memory/CPU tier; a permanently-critical memory tier keeps pressure elevated, reaping idle sessions too aggressively.
2. **Silent no-revival (the user-facing symptom):** the ResumeQueueDrainer's "machine calm" gate requires a `normal` pressure tier for `requiredCalmTicks` consecutive ticks. With memTier permanently critical, `calmTicks` resets to 0 every tick → reaped sessions NEVER revive, SILENTLY. A topic's session vanishes and never comes back; the user sees only silence. (This is the "machine swapping / 28744 not responding" incident.)

The correct macOS available-memory figure (free + inactive + purgeable) ALREADY exists in `MemoryPressureMonitor.parseVmStat` (used by HealthChecker) — but `HostPressureSampler` (which feeds the reaper + the resume-queue calm-gate) does not use it; it uses raw `os.freemem()`.

Grounded on the incident machine: `os.freemem()` = 0.17% (→ critical), but real available = 19.8% (→ `normal`, above the 12% moderate threshold). The metric is the entire bug; the gates are correct once fed the truth.

## Proposed design

Lift the platform-aware available-memory calculation into ONE shared, injectable, unit-tested helper and feed the reaper from it.

1. **New `src/monitoring/hostMemoryPressure.ts`** — pure, injectable:
   - `parseVmStat(output)` — macOS available = `Pages free + Pages inactive + Pages purgeable` (reclaimable), used% = (total − available)/total.
   - `parseProcMeminfo(content)` — Linux `MemAvailable` (or `MemFree+Buffers+Cached`).
   - `readSystemMemoryPressure(deps)` — platform-aware (darwin → vm_stat, linux → /proc/meminfo, else → rough RSS estimate); bounded (5s timeout); NEVER throws (falls back on any read error).
   - `hostFreeMemPct(deps)` — `100 − pressurePercent`, clamped 0-100 — the corrected replacement for `os.freemem()/totalmem()*100`.
2. **`HostPressureSampler.sampleHostPressureInputs`** computes `freePct` via `hostFreeMemPct()` instead of `os.freemem()`. The reaper + resume-queue + cartographer-sweep (all consumers of the one shared pressure signal) now read the truth.
3. **`MemoryPressureMonitor`** delegates its private `readSystemMemory` to the shared `readSystemMemoryPressure` (removes the duplicate vm_stat/proc parsers — ONE definition, no drift).

NO change to the reaper thresholds or the calm-gate: grounding shows the corrected metric reads `normal` on a healthy-but-busy machine, so the existing gates work correctly once fed the real figure. (The CPU side — 1-min load ÷ cores — is unchanged; that's a separate, already-tunable knob.)

## Decision points touched

This CORRECTS a measurement that feeds reaping + revival gates. It does NOT add a brittle gate or new blocking authority — it replaces a brittle, macOS-wrong metric (os.freemem) with the truthful one already proven in the codebase. The change can only make the reaper LESS aggressive and revival MORE available (the safe direction) on macOS; on Linux it switches free→MemAvailable (also more accurate, never less).

## Frontloaded Decisions

- **Signal choice** — available memory (free + reclaimable inactive + purgeable on macOS; MemAvailable on Linux), NOT the macOS kernel `vm_pressure_level` (which weights swap activity and would still over-report on a high-swap-but-high-available machine). Frontloaded.
- **Fallback on read error** — the rough RSS estimate (existing MemoryPressureMonitor behavior), never a wedge. An observability metric must not throw.
- **No threshold/calm-gate change** — grounded: the corrected metric reads `normal` (19.8% > 12%) on the incident machine; the gates are correct once fed the truth. (Separate, larger directive — a guaranteed lifeline session floor + loud no-silent-resource-rejection — is its own follow-on spec/standard, NOT this fix.) <!-- tracked: topic-28130 -->

## Open questions

*(none)*

## Multi-machine posture
Machine-local by design — each machine assesses its own memory. No replication/proxy surface; the reaper only ever evaluates its own host.
