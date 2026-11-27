# Side-Effects Review — WorktreeMonitor skips an oversize saved report at boot

## Summary of the change

`WorktreeMonitor.loadState` now `stat`s `last-report.json` before reading it, and does not parse it when it is over `MAX_SAVED_REPORT_BYTES` (16 MB). It logs one warning and starts with `lastReport = null`; the next scan writes a fresh report over the file.

Why it is needed: before #3461's 50-name cap, the saved report reached 340 MB (427 entries) on the Studio. Parsing it at boot took the server from 1.3 to 4.0 GB, and the server crashed out of memory at 2026-11-19 08:11:35Z (crash report node-2026-11-19-001152.ips; three similar on 11-18). #3461 stops new reports growing (about 2 MB here). This change covers the one boot on any machine that still holds an old file. It is stacked on #3461.

## Decision-point inventory

None that gates behaviour. The 16 MB bound only chooses between loading the old report and starting without one.

## 1. Over-block

A legitimately large capped report over 16 MB would not be loaded. That would need roughly 3,000 or more worktrees at the cap. The cost is only the loss of the previous-scan comparison until the next scan.

## 2. Under-block

A report just under 16 MB is still parsed (about 200 MB of heap at most), which is acceptable.

## 3. Level-of-abstraction fit

The check is in `loadState`, the only reader.

## 4. Signal vs authority compliance

No authority is involved.

## 4b. Judgment-point check

The 16 MB bound sits about 8 times above the measured capped size, and it fails safe: no load, and the next scan rebuilds the report.

## 5. Interactions

`getLastReport()` returns null until the first scan, the same as on a fresh install. Announced-state loading is unchanged.

## 6. External surfaces

One log line when an oversize report is skipped.

## 6b. Operator-surface quality

No operator surface.

## 7. Multi-machine posture

`machine-local-justification: hardware-bound-resource`. This is each machine's own state file.

## 8. Rollback cost

Revert the commit. No state carries over.

## Conclusion

Safe. It removes a boot-time out-of-memory path.

## Second-pass review (if required)

Not required: no gate, kill or messaging authority is involved.

## Evidence pointers

`tests/unit/worktree-monitor.test.ts`: 2 new cases. A sparse file one byte over the bound is not loaded and the warning is logged; a small report still loads. The file passes 37 of 37. tsc is clean.

## Class-Closure Declaration (display-only mirror)

Class: unbounded-self-action. Closure: n/a. This is a boot-time read guard, with no self-triggered action.
