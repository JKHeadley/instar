# Convergence Report — macOS memory-pressure metric

## Cross-model review: SKIPPED-ABBREVIATED (single-framework, urgency)

Live incident fix (topic 28744 not responding); external cross-model passes skipped. The code-backed Standards-Conformance Gate + the mandatory lessons-aware reviewer ran and produced real findings, so the abbreviated round was not a rubber-stamp.

## Iteration Summary

**Round 1**
- **Standards-Conformance Gate: ran (1 flag).** "Scrape/Parser Fixture Realness — feed the parser the REAL bytes" (the code=t lesson): the spec adds vm_stat / /proc/meminfo parsers but the tests used only hand-written fixtures. → ADDRESSED: captured REAL `vm_stat` output from the incident machine (`tests/fixtures/memory/vm_stat-real-darwin.txt`) + a real-shape `/proc/meminfo` fixture, with tests asserting the parsers produce the correct available% against the real bytes (incl. the live bug shape — tiny raw free pages, healthy available).
- **Lessons-aware reviewer: NO BLOCKERS.** Verified: (a) the RSS fallback biases toward LOW pressure (server RSS ≪ host RAM) → reaper LESS aggressive + revival MORE available — the SAFE direction; ResumeQueueDrainer.safeTier() independently fails closed on error (backstop). (b) The change correctly serves "No Silent Degradation to Brittle Fallback" (the bug WAS a brittle os.freemem metric silently degrading availability). (c) The reused vm_stat calc is byte-identical to the old MemoryPressureMonitor private parser (confirmed vs HEAD~1); `active`/`compressor` exclusions are correct (conservative, safe direction); delegation is behavior-preserving (with a minor improvement — empty/garbage output now falls to the RSS estimate instead of a false `normal`). (d) "No threshold/calm-gate change" is correct for the incident (machine reads `normal` at 19.8% > 12%).
  - **Minor 1 (Observability) — ADDRESSED:** the fallback catch didn't log; added a one-line `console.warn` so a genuinely-broken vm_stat surfaces instead of hiding behind the RSS estimate.
  - **Minor 2 (note, not a blocker) — TRACKED:** a machine genuinely at 5-12% available reads `moderate` and would still never reach 3 consecutive `normal` ticks → revival held (now for a REAL reason, not a measurement bug). This is the separate "guaranteed lifeline session floor + loud no-silent-resource-rejection" directive, already a frontloaded follow-on (`topic-28130`). Kept open — it's the real fix for the busy-but-healthy `moderate` machine.

**Round 2 (convergence check)** — both minors resolved/tracked; no new material findings; the metric fix is correct + behavior-preserving + safe-direction. **Converged.**

## Material findings & resolutions
| Sev | Finding | Resolution |
|-----|---------|------------|
| flag | parser tests use synthetic, not real, bytes | real captured vm_stat + real-shape proc-meminfo fixtures |
| MINOR | fallback not logged (Observability) | one-line warn on fallback |
| NOTE | moderate-machine still never revives | tracked: lifeline-floor follow-on (topic-28130) |

## Decision-completeness
All decisions frontloaded; `## Open questions` empty. The change biases reaping/revival in the safe direction on macOS (and is more accurate on Linux); the larger session-floor + transparency directive is a tracked, separate follow-on.
