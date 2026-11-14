# Convergence Report — Telegram Origin Store Retention

**Spec:** [docs/specs/telegram-origin-store-retention.md](../telegram-origin-store-retention.md)
**Slug:** `telegram-origin-store-retention`
**Iterations:** 6 (the Tier 2 cap)
**Final-round design findings:** 4, of which 2 fixed and 2 accepted below

## Cross-model review: codex-cli:gpt-6-astra

Codex ran on all six rounds. Gemini was unavailable (not signed in). One independent internal reviewer ran on round 1, and a second-pass code review ran before commit.

## ELI10 Overview

The database that records every outgoing Telegram message grew to 644 MB. A cleanup that runs once a minute spent 3 to 9 seconds searching it, and the database can only do one thing at a time, so replies arriving then were held. This spec makes the cleanup fast and puts limits on everything: full message detail moves to archive files after seven days, a small searchable record stays, and history older than a year is removed by default.

Nothing changes in what gets sent. The file stays at its current size and stops growing, because shrinking it would hold replies for about 37 seconds.

## Original vs Converged

Review changed the design substantially. The fence against a double send moved from origin id, which logical retries change, to a new operation index that also keeps receipt lookups working. Automatic VACUUM was removed after measurement. Only the server runs retention now, the busy timeout rose to 250 ms, and batches adapt to disk speed. Rows that have to wait no longer stop later rows. Operations with a reserved notice, an unreported expiry or an unfolded receipt are protected. `superseded` now counts as terminal for admission.

## Iteration Summary

| Round | Design findings | Outcome |
|---|---|---|
| 1 | 5 Codex, 9 internal | Operation index, seven-day line stated, compaction size cap, future-dated rows, server-only retention, fold marker, VACUUM limits |
| 2 | 3 Codex | Purge scan progress, receipts protected, owners note accepted |
| 3 | 3 Codex | Reserved notices held from archive, scan runs past a waiting row, manifest scan bounded |
| 4 | 4 Codex | Archive garbage collection fixed; others accepted or queued |
| 5 | 3 Codex | Rotating manifest scan, bounded compaction reads |
| 6 | 4 Codex | `superseded` made terminal, fold marker fallback; 2 accepted |

## Full Findings Catalog

Every finding is recorded in the table above and resolved in the spec, except those under Left behind.

## Proportion

Tier 2, about 600 lines. Six rounds is the cap. Each round found something real, though from round 4 on they were corner cases. The cap ended the loop, as designed.

## Left behind

Accepted risks, none about safety, security or data loss:

- **A retention step cannot be interrupted.** During the backlog on a machine at load 25, a few steps took 1 to 2 s from cold, so a reply could occasionally wait that long. After the backlog steps take under 100 ms. Moving file work off the worker is more than this fix needs.
- **Unreferenced archive files after a crash.** A crash or failed delete can leave a file no manifest points at. This costs disk only and is queued as feedback.
- **`created_at` is not strictly ordered by insertion.** A row arriving late behind a younger one waits until the younger one ages, so detail can stay hot for up to 21 days.
- **A repeated event older than the line could count twice**, leaving a non-decision counter off by one.
- **A `legacy-unattributed` origin imported out of order** can lower a federated count by a few, on legacy rows only.
- **Owner rows** are capped by age, not by reference; 2,000 rows is about 200 days of boots, far past the 14-day archive line.

## Convergence Verdict

Converged at the Tier 2 cap with the accepted risks above.
