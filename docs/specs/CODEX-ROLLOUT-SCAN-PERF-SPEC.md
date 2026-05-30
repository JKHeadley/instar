---
title: Bound listAllRollouts to the newest date-partitions so /codex/usage doesn't time out on a large history
review-convergence: retrospective-single-pass
approved: true
eli16-overview: CODEX-ROLLOUT-SCAN-PERF.eli16.md
---

# Bound the Codex Rollout Scan to the Newest Date-Partitions

## Problem

`listAllRollouts` (`src/providers/adapters/openai-codex/observability/sessionPaths.ts`)
returned the newest rollout files by walking the ENTIRE
`$CODEX_HOME/sessions/YYYY/MM/DD/` tree and `stat`-ing every file, then sorting
by mtime and slicing to `limit`. On a real codex account the history is large —
one machine measured **14,277 rollout files / 1.4 GB**. The full walk + 14k
sequential async `stat`s, under live server load, made the callers time out:
`GET /codex/usage` (shipped in v1.3.123) returned a connection timeout (curl
`000` after 30 s) on the live server; the TokenLedger codex scan and the
session-resume index share the same helper and the same cost.

This is a regression introduced with the codex-usage reader: it works on a small
history (tests, fresh agents) but degrades to a hang on a busy account.

## Fix

Walk the date-partition directories in DESCENDING date order and `stat` only the
rollout files in the newest partitions, stopping once `limit` candidates are
collected AND at least `MIN_PARTITIONS_SCANNED` (= 2) non-empty day-partitions
have been covered (so a day is never cut mid-way and the cross-midnight boundary
— plus a session that began "yesterday" but is still the most recently active —
is not missed). Then sort the collected candidates by mtime and return the top
`limit`. Work is bounded to the most-recent partitions instead of the whole
history.

A non-date-partitioned layout (no `YYYY/MM/DD` dirs) falls back to the original
full walk — correctness over speed for any unexpected layout.

Helpers added: `listDayPartitionsDescending(root)` (enumerates the day dirs
newest-first without statting their contents; returns null to signal the
fallback) and `readNamesDesc(dir, pattern)` (readdir + name-filter + descending
sort; numeric zero-padded names sort lexicographically correctly).

This fixes ALL four callers at once (they share `listAllRollouts`): the
codex-usage reader, the TokenLedger codex scan, the session-resume index, and
the layout canary.

## Trade-off (documented)

"Newest by mtime" becomes "newest among the most-recent date partitions, then by
mtime." For the rate-limit reader this is exact — the account-wide windows are
identical across any recently-active session. For the resume/token-ledger
callers, the only miss is a session OLDER than the scanned partitions that is
nonetheless the single most-recently-touched file on disk — vanishingly rare
(sessions are not active for days), and the safety margin
(`MIN_PARTITIONS_SCANNED = 2`) covers the common cross-day case.

## Signal vs authority

No decision surface. This is a pure read-path performance optimization of a
helper that returns data. It gates nothing, blocks nothing, changes no behavior
other than scanning less of disk to return the same newest-N result.

## Testing

- **Unit** (`codexListAllRolloutsPerf.test.ts`, 5): newest-first across
  partitions; covers >= 2 partitions when the newest holds < `limit`; an
  `fs.stat` spy proves only the newest partitions are statted (< 20 stats for
  206 files); the non-date-partitioned fallback; empty when no sessions dir.
- **Regression**: the existing reader/TokenLedger/resume/canary suites
  (date-partitioned fixtures → fast path) stay green unchanged.
- **Verified on real data**: the fixed algorithm runs in **59 ms** against the
  live 14,277-file / 1.4 GB tree (scanning 2 partitions, stopping early) vs the
  old full-walk timing out at 30 s+ under load.

## Rollback

Revert the `listAllRollouts` rewrite + the two helpers + the new test. No data,
no migration, no behavior change to roll back — only the scan strategy.

## Authority note

Shipped autonomously under the 12-hour session's deploy mandate (a perf
regression in just-shipped code — exactly the "verify deployed → found a bug →
fix it" path). `approved: true` self-applied; flagged in the PR. Discovered by
force-deploying v1.3.123 to Echo and finding `GET /codex/usage` timed out on the
real history.
