# Side-Effects Review — bound the codex rollout scan to the newest partitions

**Version / slug:** `codex-rollout-scan-perf`
**Date:** 2026-05-30
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** not required (pure read-path perf optimization; no block/allow/lifecycle/decision surface)

## Summary of the change

`listAllRollouts` (`src/providers/adapters/openai-codex/observability/sessionPaths.ts`)
no longer walks + `stat`s the ENTIRE `$CODEX_HOME/sessions` tree to return the
newest-N rollouts. It now walks date-partition dirs newest-first and stats only
the newest partitions (>= 2, until `limit` candidates), with a full-walk
fallback for non-date-partitioned layouts. Fixes the `GET /codex/usage` timeout
(and the shared TokenLedger / resume-index cost) on a large codex history
(measured 14,277 files / 1.4 GB → route timed out at 30 s; now 59 ms).

## Decision-point inventory

- No decision point. `listAllRollouts` returns data (a list of file paths +
  mtimes). The change is purely the disk-scan strategy used to produce that
  list; the returned newest-N is unchanged for the common case.

---

## 1. Over-block
No block/allow surface — not applicable. It returns a file list; it rejects
nothing.

## 2. Under-block
Not applicable. The closest "miss" is the documented trade-off: a session OLDER
than the scanned partitions yet still the single most-recently-touched file on
disk would not be in the candidate set. For the rate-limit reader this changes
nothing (account-wide windows are identical across any recently-active session);
for the resume/token-ledger callers it is a vanishingly rare miss (sessions are
not active for days) and `MIN_PARTITIONS_SCANNED = 2` covers the common
cross-midnight case.

## 3. Level-of-abstraction fit
Correct layer — the fix is in the shared helper, so all four callers
(codex-usage reader, TokenLedger scan, resume index, layout canary) get the
speedup from one change rather than each re-implementing a bounded scan.

## 4. Signal vs authority compliance
Compliant — no authority at all. A read helper that returns data; it gates,
blocks, and decides nothing (`docs/signal-vs-authority.md` n/a beyond "this is
not a decision point").

## 5. Interactions
- **Shared helper:** all callers benefit; none depend on the *full* unbounded
  list (every caller passes a `limit` and wants newest-N). Verified the four
  call sites pass a finite limit.
- **No races / no writes:** read-only; opens + closes its own dir/file handles.
- **Canary:** `codexSessionLayoutCanary` uses date-partitioned fixtures → hits
  the fast path → stays green (verified).

## 6. External surfaces
- Makes `GET /codex/usage` actually responsive on a heavy account (it returns
  fast instead of timing out). No change to the response shape or semantics.
- No new route, no message, no change visible to other agents.

## 7. Rollback cost
Trivial. Revert the `listAllRollouts` rewrite + the two private helpers + the new
test. No data, no migration, no behavior to repair — only the scan strategy.
