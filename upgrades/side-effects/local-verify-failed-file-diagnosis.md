# Side-Effects Review — Failed-file diagnosis

**Version / slug:** `local-verify-failed-file-diagnosis`  
**Date:** `2026-10-31`  
**Author:** Echo

## Summary

An optional, off-by-default coordinator asks an idle peer to compare a small, exact set of assertion-failing files on the PR merge and base. The diagnostic journal and peer child are separate from merge-authorizing Local Verify records. Spec: `docs/specs/local-verify-cross-machine-failed-file-diagnosis.md`.

## Decision-point inventory

- `laneReport.ts`, `orchestrator.ts`, `record.ts`: **validate** that every named file is an inventoried assertion failure from a full PR run, never a collection error or truncated larger set.
- `FailedFileDiagnosisCoordinator.ts`, `failedFileDiagnosisStore.ts`: **reserve** one exact key durably and dispatch only with current head/base/lease and no waiting full verify.
- `FailedFileDiagnosisPeerService.ts`, `runFailedFileDiagnosis.ts`, `diagnosisSeams.ts`: **run** one bounded child, use the targeted test lane, preempt before full verify, and refuse uncertain cleanup.
- `localVerifyRoutes.ts`, `failedFileDiagnosisClient.ts`: **expose** separate authenticated advisory routes and a projection beside the stored red record.
- `PostUpdateMigrator.ts`, `scaffold/templates.ts`: **ship** the dark default and teach installed agents the limited meaning of a diagnosis.

## Over-block and under-block

An eligible red PR can use up to 15 additional peer machine minutes and two targeted runs per failed file. The peer refuses when busy or when versions, policy, lease, head or base differ. A failed or uncertain comparison is inconclusive; no diagnostic path blocks or clears a PR merge. Full verify preempts the child and owns its normal suite slot. A transport timeout does not retry the exact key automatically.

## Signal and authority

The result is signal only. It is never written into `LocalVerifyRecord`, the execution index, main health or GitHub statuses. A green merge still needs the full, exact-head Local Verify record and all existing safe-merge gates. File-level reproduction is weaker than assertion-level agreement; the API shows raw observations and exact SHAs so the label cannot be mistaken for authority.

## Multi-machine and rollback

The serving lease holder owns the queue and journal; each peer owns only its current child and bounded result/tombstone store. A lease move invalidates the old attempt for current decisions. Set `monitoring.localVerify.failedFileDiagnosis` to `off` to stop new requests; an admitted child finishes within its existing bound unless a full verify preempts it. Existing agents receive the off default and CLAUDE.md awareness through migration.

## Rollout and evidence

The feature remains off until an isolated rehearsal, then a 24-hour Echo observe window measures eligible failures and predicted machine minutes. One-peer auto runs only after that evidence shows useful diagnostic yield without merge-slot wait. Unit, HTTP integration, production lifecycle and full-suite results are recorded with the PR.
