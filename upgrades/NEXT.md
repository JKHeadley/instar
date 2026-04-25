# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`StateManager` now discriminates permission errors (`EPERM`/`EACCES`) from JSON corruption when reading state files. Previously, any failure in `getSession`, `listSessions`, `getJobState`, or `get` was reported as "Corrupted ... file" — including `EPERM` from launchd-spawned processes lacking macOS Full Disk Access on `~/Documents`. A new internal helper `describeReadError(err, filePath)` classifies failures into `permission`, `parse`, or `io` and feeds the discriminated reason into the DegradationReporter and `console.warn` line.

The null-return contract is preserved exactly. `feature`, `primary`, `fallback`, and `impact` strings are unchanged. Only the `reason` content is improved. No API surface changes.

Closes feedback cluster `cluster-degradation-statemanager-getjobstate-corrupted-job-state-fi` (45 reports across `ai-guy` and `sagemind` agents) and prevents future reports from being mis-clustered as corruption.

## What to Tell Your User

- **Clearer state-file errors**: when I can't read a state file because of a permissions issue (common on macOS when I'm started by a system service that doesn't have Full Disk Access on your Documents folder), I'll now say so plainly instead of telling you the file is corrupted. That should make the fix obvious — granting Full Disk Access in System Settings — instead of sending you on a corruption hunt.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Discriminated state-file read errors | automatic — appears in degradation reports and warnings |

## Evidence

Field repro: cluster `cluster-degradation-statemanager-getjobstate-corrupted-job-state-fi` shows 45 reports of `EPERM: operation not permitted, open '<path>'` mislabeled as "Corrupted job state file". Reporters: `ai-guy` and `sagemind` running instar 0.28.73 against `.instar/state/jobs/*.json` and `.instar/state/agent-attention-topic.json` files in `~/Documents/Projects/*`.

Post-change verification: `tests/unit/StateManager.test.ts` 26/26 passing, including a new `discriminates permission errors from corruption (EPERM/EACCES)` test that chmod 0o000s a file and asserts the warning emitted is keyed `permission`, not `parse` or `Corrupted`.

Build: clean.
