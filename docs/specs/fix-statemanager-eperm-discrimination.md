---
title: "fix(StateManager): discriminate EPERM/EACCES from JSON corruption"
slug: "fix-statemanager-eperm-discrimination"
author: "dawn"
status: "converged"
review-convergence: "2026-04-25T09:15:00Z"
review-iterations: 1
review-completed-at: "2026-04-25T09:15:00Z"
approved: true
approved-by: "dawn"
approved-date: "2026-04-25"
approval-note: "Autonomous instar-bug-fix LOW-risk diagnostic-only change. Single converged spec per grounding doc precedent (echo's prior fixes for similar diagnostic discrimination). Cluster cluster-degradation-statemanager-getjobstate-corrupted-job-state-fi (governance: implement, severity: critical, 45 reports across 3 agents). The change ONLY relabels error reasons; the null-return contract and all caller behavior are preserved (verified by 26/26 unit tests passing, including the existing 'returns null' contracts and a new permission-discrimination test). No external API surface changes. No data shape changes. Pure observability/operator-experience improvement."
---

# fix(StateManager): discriminate EPERM/EACCES from JSON corruption

## Problem statement

Cluster `cluster-degradation-statemanager-getjobstate-corrupted-job-state-fi` (45 reports, governance=implement). Four read paths in `src/core/StateManager.ts` (`getSession`, `listSessions`, `getJobState`, `get`) wrap `JSON.parse(fs.readFileSync(...))` in a single `try/catch` and report ALL failures with the label "Corrupted ... file". On macOS this misleads operators and the feedback pipeline:

- `launchd`-spawned processes hitting `~/Documents` without Full Disk Access get `EPERM`. That is a **permissions** issue, not corruption.
- `EACCES` on a chmod'd file is similarly a permissions issue.
- Genuine `JSON.parse` failures are corruption.
- Other I/O errors are I/O errors.

Conflating these costs feedback-evolution time chasing nonexistent corruption, and gives users a misleading error message ("Corrupted state file") when the actual remediation is "grant Full Disk Access to launchd".

Field evidence (from cluster):
- 45 reports across 3 agents (`ai-guy`, `sagemind`) all show `EPERM: operation not permitted, open '...'` on files under `~/Documents/Projects/*/.instar/state/...`.
- All currently labeled `Corrupted job state file: EPERM ...` — semantically wrong.

## Proposed design

A single helper `describeReadError(err, filePath)` in `StateManager.ts` returns a `{reason, kind}` discriminating three cases:

1. **`permission`** (`err.code === 'EPERM' || 'EACCES'`): reason names the permission denial AND mentions Full Disk Access on macOS as the typical remediation.
2. **`parse`** (`err instanceof SyntaxError`): reason calls out JSON parse failure.
3. **`io`** (anything else): generic read failure with the errno code if present.

All four StateManager read sites use the helper. The console.warn prefix and the DegradationReporter `reason` field reflect the discriminated kind. The `feature`, `primary`, `fallback`, `impact`, and the null-return contract are unchanged.

## Decision points touched

None. This is a diagnostic-only change. No block/allow surface added. No caller-visible behavior change.

## Risk classification

**LOW**:
- No public API surface change.
- No data format change.
- All existing tests pass unchanged.
- The null-return contract is preserved (verified by `tests/unit/StateManager.test.ts` 25 pre-existing tests + 1 new test).
- Rollback is `git revert` + patch release. No persistent state.

## Evidence

- Pre-change: errors from `EPERM` paths in the field reported as "Corrupted job state file" in the DegradationReporter feed (cluster shows 45 such reports).
- Post-change: same errors will report as "Permission denied reading <path> (EPERM). On macOS, launchd-spawned processes need Full Disk Access to read under ~/Documents." with `kind: permission`.
- Test: `tests/unit/StateManager.test.ts` 26/26 passing including new `discriminates permission errors from corruption (EPERM/EACCES)` test.
- Build: clean (`npm run build`).

## Rollback

`git revert` + patch release. No persistent state needs cleanup. Agents that ran the fixed code are forward-compatible with reverted code (the reverted code reads the same JSON files and reports under the same `feature` names).

## Caller invariants

Callers of `getSession`, `listSessions`, `getJobState`, `get` already handle `null` returns (the documented fallback). The `feature`, `primary`, `fallback`, `impact` fields of the degradation report are unchanged — only `reason` content is discriminated. Pipelines that group by `feature` or `fallback` continue to work; pipelines that group by `reason` get strictly better signal (three categories instead of one mislabeled bucket).
