# Side-Effects Review — three switched-off features record what they do

**Version / slug:** `maturation-tracking-benchmark-dynamicmcp-redrive`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds evidence rows for three ladder features whose tracking was marked `needed`: `benchmarkDivergence`, `sessions.dynamicMcp` and `monitoring.collaborationRedrive`. Rows go through the existing `featureEvidence` call, which never throws. The three ladder entries move to `tracking.state: measured` with plans that say what is recorded. No feature's behaviour, thresholds, flags, defaults or rungs change. Files: `src/monitoring/BenchmarkDivergenceAnalyzer.ts`, `src/core/DynamicMcpService.ts`, `src/monitoring/CollaborationRedriveEngine.ts`, `src/data/feature-ladders.json`, three unit test files.

## Decision-point inventory

- Benchmark analysis pass — pass-through — one row per finished pass; verdict logic untouched.
- Dynamic MCP change request — pass-through — reads the existing audit line; authorization, restart and rollback untouched.
- Collaboration re-drive eligibility and caps — pass-through — records what the existing checks decided; no check moved.
- Maturation ladder — pass-through — existing metric definitions now have rows to read; no bar was edited.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface. Recording gaps that remain, stated so nobody reads silence as health:

- A benchmark pass that loses its lease mid-pass writes no row, because it is not a finished pass.
- A re-drive `fired` row means the nudge was handed to the relay. The relay accepts asynchronously, so a later delivery failure is not seen here.
- The re-drive per-tick pacing limit writes no row. That check runs before eligibility, so it cannot say a sendable nudge was stopped.

---

## 3. Level-of-abstraction fit

Right layer: each row is written at the one place the decision is already made. Dynamic MCP records in its composition root, so every construction and the idle sweep are covered without depending on the host passing an audit sink.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Rows are signals the ladder and reviews read. Nothing here blocks anything.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals decision point. The fired/held split on a benchmark pass restates two facts the analyzer already computes.

---

## 5. Interactions

- **Ladder denominators.** Ladder ratios divide by all of a feature's rows, so extra rows can hide a real error rate. This drove three choices. Dynamic MCP writes nothing for a no-op or a pending approval. Benchmark writes exactly one row per pass. Re-drive held rows are limited to one per reason per day, carrying `suppressedSinceLast`, and routine skips (not silent yet, spacing, a commitment already at its cap) write nothing.
- **`stale-mirror-rate` also counts coverage-incomplete passes.** The ladder plan defines held as stale mirror or incomplete coverage, and the bar counts all held rows. On a multi-machine agent with an offline peer this bar fails for a coverage reason. Each row's reason says which applied, so a review can separate them. The bar is not edited here.
- **FD13 (benchmark dryRun: zero detector-owned durable writes).** A dryRun pass writes a row, marked `dryRun: true`, to the shared ladder log, matching the precedent in `CrashLoopPauser`. The detector's own stores stay untouched; the existing FD13 tests and a new one confirm this.
- **Dynamic MCP `aborted`.** A mid-tool-use abort is the safety check working, yet the ladder plan counts it as an error. Implemented as written; `context.outcome` separates it for a reviewer.
- **Rate limiter state** is in memory, so a restart can write one extra row per key. Harmless.

---

## 6. External surfaces

Adds rows to `logs/feature-evidence.jsonl`, read by the ladder and the maturation board. The three features will read `measured` rather than `needed`. Rows hold ids, peer names, server names, counts, dates and model names, and no message text; the log scrubs and clips strings. No outbound message, route or config changes.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No markup or renderer changed. The revised plan text appears wherever the ladder already shows it.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, like every feature-evidence row: each machine records what it did, tagged with `machine`, and the ladder reads each machine's log. Benchmark rows come only from the lease holder, because only the holder runs a pass.

**Status surfaces:** no new or changed status, health or capabilities route.

---

## 8. Rollback cost

Revert the commit. No migration and no state repair. Rows already written stay as inert history and age out with log rotation.

---

## Conclusion

Safe to ship: observation only, with every feature's decisions unchanged. It does not make any feature ready. On Echo the `benchmark-divergence-analysis` job is disabled and the benchmark mirror dates from 2026-07-24, so benchmark rows will not appear until that job runs, and will read held until the mirror is refreshed. Both features with a flag stay off.

Second pass is not required: the change touches no block/allow decision and no session lifecycle logic. The Dynamic MCP change reads an audit line after decisions are made, and a test confirms a throwing sink does not change the result. This session was also told not to start further agents, so no independent review ran, and the PR is the review surface.

## Evidence pointers

- Unit tests added to `tests/unit/BenchmarkDivergenceAnalyzer.test.ts`, `tests/unit/dynamic-mcp-service.test.ts` and `tests/unit/CollaborationRedriveEngine.test.ts`.
- Live read 2026-11-06: `GET /benchmark-divergence` analysis window ending 2026-08-21; `GET /jobs` shows `benchmark-divergence-analysis` with `enabled: false`.
