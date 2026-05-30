# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fixed: `GET /codex/usage` (and the codex TokenLedger / resume scans) timed out
on a large codex history.** The shared helper `listAllRollouts` walked the ENTIRE
`$CODEX_HOME/sessions` tree and `stat`-ed every rollout file before slicing to
the newest few. On a real account that history is large — one machine measured
14,277 files / 1.4 GB — so the full walk plus ~14k sequential `stat`s, under
live server load, made `GET /codex/usage` (shipped in v1.3.123) return a
connection timeout. It now walks the date-partition directories
(`sessions/YYYY/MM/DD/`) newest-first and `stat`s only the newest partitions
(at least two, until it has `limit` candidates), with a full-walk fallback for
any non-date-partitioned layout. The returned newest-N is unchanged; only the
scan is bounded. This one change fixes all four callers of the helper (the
codex-usage reader, the TokenLedger codex scan, the session-resume index, and
the layout canary).

## Summary of New Capabilities

- No new capability — a performance fix. `listAllRollouts` is now bounded to the
  most-recent date partitions (helpers `listDayPartitionsDescending` +
  `readNamesDesc`), so codex usage/ledger/resume reads stay fast regardless of
  how much rollout history has accumulated.

## What to Tell Your User

The codex usage check now answers instantly even on a heavy account. Before this
fix, on an account with a very large codex history, asking how much codex usage
was left could hang and time out, because the check was reading through the
entire history to find the most recent record. It now looks only at the most
recent day or two of records, so it returns right away. Nothing else changes.

## Evidence

**Reproduction.** On a real codex account with 14,277 rollout files (1.4 GB)
under `~/.codex/sessions`, hitting `GET /codex/usage` on the running server
returned a connection timeout — curl reported status 000 after a 30-second
`--max-time`, while `GET /health` on the same server responded normally. Root
cause confirmed by reading the code: `listAllRollouts` recursively walked the
whole tree and awaited an `fs.stat` on every one of the 14k files before
sorting and slicing.

**Before / after.** The old full-walk timed out at 30 s+ under load. The fixed
date-partition walk, run against the same live 14,277-file tree, completed in
**59 ms** (it scanned the two newest day-partitions, found the newest rollout,
and stopped) — returning the same newest record. A unit test with 206 fixture
files across 42 partitions uses an `fs.stat` spy to assert fewer than 20 stats
occur (only the newest partitions), versus 206 before. All three test tiers for
the codex-usage feature plus the TokenLedger / resume / canary suites stay
green.
