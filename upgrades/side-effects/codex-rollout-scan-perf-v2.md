# Side-Effects Review — stat only the newest-created candidates (perf v2)

**Version / slug:** `codex-rollout-scan-perf-v2`
**Date:** 2026-05-30
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** not required (pure read-path perf optimization; no block/allow/lifecycle/decision surface)

## Summary of the change

`listAllRollouts` no longer `stat`s every file in the newest date-partitions
(~3,637 on the real machine). It collects candidate paths via `readdir` (no
per-file stat), sorts them by the creation timestamp embedded in the path, and
`stat`s ONLY the top `limit * STAT_OVERSCAN` (= 32 for the reader). Fixes
`GET /codex/usage` still timing out after the v1 fix because ~3,637 sequential
`await fs.stat`s are pathological under a CPU-starved event loop (server log:
"Drift ~14s … CPU starvation"). 14,277-file tree: 32 stats / 14 ms (was ~3,637).

## Decision-point inventory

- No decision point. A read helper returns a file list; only the disk-scan
  strategy changed.

---

## 1. Over-block / ## 2. Under-block
No block/allow surface. The only "miss" is the documented trade-off (a session
created older than the newest `limit*4` yet still the single most-recently-
touched file) — irrelevant for the rate-limit reader (account-wide windows) and
vanishingly rare for the other callers.

## 3. Level-of-abstraction fit
Correct — the shared helper, so all four callers (codex-usage reader, TokenLedger
scan, resume index, canary) get the speedup from one change. The filename-as-
creation-timestamp ordering is a property of the codex layout the helper already
encodes.

## 4. Signal vs authority compliance
Compliant — no authority; a read-only reporter.

## 5. Interactions
- **Callers:** all pass a finite `limit` and want newest-N; the bounded-stat set
  preserves that. `readdir` returns all names in one syscall (cheap); the
  in-memory path sort of a few thousand strings is sub-ms.
- **No writes / no races:** read-only; opens + closes its own handles.
- **Robust under load:** the whole point — it now makes ~32 awaits instead of
  ~3,637, so a starved event loop no longer makes the call hang.

## 6. External surfaces
- `GET /codex/usage` becomes responsive on a heavy account even when the server
  is CPU-starved. Response shape/semantics unchanged.
- No new route, no message.

## 7. Rollback cost
Trivial — revert the `listAllRollouts` body to the v1 form. No data, no
migration.
