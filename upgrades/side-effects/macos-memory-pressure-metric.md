# Side-effects review — macos-memory-pressure-metric

Change: replace `os.freemem()`-based memory-pressure measurement with REAL available memory (free+inactive+purgeable via vm_stat on macOS; MemAvailable on Linux) in the SessionReaper's pressure input. New `src/monitoring/hostMemoryPressure.ts` (shared); `HostPressureSampler` + `MemoryPressureMonitor` use it. Files: hostMemoryPressure.ts (new), HostPressureSampler.ts, MemoryPressureMonitor.ts, tests + real fixtures.

1. **Over-block:** REDUCES a false over-block — the reaper no longer reads a healthy macOS machine as memory-critical, so it stops over-reaping idle sessions and the resume queue's calm-gate can reach `normal` and revive reaped sessions.
2. **Under-block:** None new. The corrected metric is conservative (excludes active + compressor from "available", the safe direction). On a genuinely memory-critical machine it correctly reads critical. A 5-12% `moderate` machine still holds revival (now for a REAL reason, not a false one) — tracked separately as the lifeline-floor follow-on (topic-28130).
3. **Level-of-abstraction fit:** Correct. One shared, injectable memory reader feeds all consumers of the single host-pressure signal (reaper, resume-queue, cartographer-sweep). Removes a duplicate vm_stat parser (one definition).
4. **Signal vs authority:** Not a gate — a measurement that FEEDS gates. The fix makes the signal truthful; it adds no blocking authority. Serves "No Silent Degradation to Brittle Fallback" (os.freemem was the brittle metric silently degrading availability).
5. **Interactions:** The reaper's CPU side (1-min load ÷ cores) is unchanged. MemoryPressureMonitor delegation is byte-identical to its prior private parser (confirmed vs HEAD~1) — HealthChecker behavior preserved. The fallback (RSS estimate on read error) biases low-pressure (server RSS ≪ host RAM) → safe direction; now logged (Observability). ResumeQueueDrainer.safeTier() independently fails closed on error — backstop intact.
6. **External surfaces:** No routes. `GET /sessions/reaper`'s `pressure.inputs.freePct` now reports real available% (was ~0.1% on macOS). A `[hostMemoryPressure]` warn on read-failure fallback.
7. **Multi-machine posture:** Machine-local by design — each host measures its own memory. No replication/proxy surface.
8. **Rollback cost:** Low. Pure measurement change; revert restores os.freemem. No data migration, no config. The change can only relax the reaper / free revival on macOS (the safe direction), so a bad outcome is bounded.

## Second-pass review (touches the reaper pressure path)
The lessons-aware convergence reviewer audited fail-direction, the parent standard, the reused vm_stat calc (byte-identical, correct exclusions), delegation (behavior-preserving), and the no-threshold-change claim. No blockers; one minor (log the fallback — DONE), one tracked note (moderate-machine residual → lifeline-floor follow-on). Concur.
