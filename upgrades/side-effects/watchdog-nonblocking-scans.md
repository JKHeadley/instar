# Side-Effects Review — SessionWatchdog non-blocking process scans

**Version / slug:** `watchdog-nonblocking-scans`
**Date:** `2026-06-07`
**Author:** `Echo`
**Tier:** 1 (internal monitor refactor; no API/route/config/migration surface)
**Second-pass reviewer:** `Echo (self) — Tier-1; the behavior-equivalence + ordering analysis below is load-bearing`

## Summary of the change

`SessionWatchdog` polled every 30s over EVERY running session, running several
`ps`/`pgrep` probes per session via **synchronous** `spawnSync` (5s timeout each).
Each probe blocked the single Node event loop for its full duration; under load
(dozens of sessions, a busy box) the cumulative stall made the server miss its own
`/health` window → false "server temporarily down" + restart loop (2026-06-07 topic
21816 incident). This converts the watchdog's process scans to async (`execFile`) and
makes the poll yield the loop between sessions. File: `src/monitoring/SessionWatchdog.ts`.

- `shellExec` (spawnSync) → `shellExecAsync` (`promisify(execFile)`); returns captured
  stdout or '' on non-zero exit/timeout — identical to the prior `.stdout ?? ''`.
- `getFrameworkPid`, `getClaudePid`, `getChildProcesses`, `hasActivePipelineSibling`,
  `checkCompactionIdle` are now `async`; all internal callers (`checkSession`,
  `checkCompactionIdle`) `await` them.
- `poll()` `await new Promise(setImmediate)` between sessions so a scan over many
  sessions can never monopolize the loop.

## Decision-point inventory

- The watchdog's escalation/kill decisions are UNCHANGED — only the I/O mechanism of
  the read-only process probes changed (sync → async). Same commands, same parsing,
  same thresholds, same LLM gate.
- No message block/allow surface. No new route/config/migration.

## 1. Over-block (escalating a session that shouldn't be)

Behavior is preserved: the probe commands, output parsing, stuck-thresholds, pipeline
guard, and LLM gate are byte-for-byte the same. `execFile`'s non-zero-exit throw is
caught and mapped to the captured stdout (or '') — matching `spawnSync(...).stdout ??
''`, which never threw. So a pgrep/egrep no-match still reads as "no PID / no children",
exactly as before. No new false escalation path.

## 2. Under-block (missing a genuinely stuck session)

The scans now interleave with other event-loop work, but each poll still visits every
session and runs the same probes; nothing is skipped. The 5s per-probe timeout is
preserved (passed to execFile). A probe that times out returns '' (treated as
"unknown / no match") exactly as the sync version did. The `running` re-entrancy guard
still prevents overlapping polls.

## 3. Level-of-abstraction fit

Correct layer. This is the same OS-process read, moved off the synchronous path so it
shares the loop cooperatively. No LLM involved in the scan itself.

## 4. Ordering / concurrency

The methods became async, so within a single `checkSession` the probes now `await`
(yield) between steps. A session could be killed between two awaited probes — but the
existing code already tolerates "process gone" (empty output → null/empty list), so a
mid-scan disappearance degrades to the same no-op as a dead pid. The per-session
`await` + the inter-session `setImmediate` only ADD yield points; they do not reorder
the decisions within a session.

## 5. Blast radius

Single file. The watchdog is opt-in (`monitoring.watchdog.enabled`). The async
conversion does not change what the watchdog DOES, only that it stops starving the
event loop while doing it. Tests for compaction/pipeline/mcp-exclusion/rate-limit all
pass unchanged (their sync `mockReturnValue` stubs work under `await`).

## 6. Rollback

Pure code revert. No state/format/config change.

## 7. Tests

`tests/unit/SessionWatchdog-nonblocking.test.ts` (new): the scanning helpers return
Promises (async), a 0ms timer fires during an in-flight probe (loop stays live), and
source guards assert no `spawnSync(` call, `execFileAsync` present, the three helpers
are async, and `poll()` yields via `setImmediate`. Existing watchdog suites updated to
`await` the now-async methods. 72 watchdog unit tests green; `tsc --noEmit` clean.
