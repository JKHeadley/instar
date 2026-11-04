# Side-Effects Review — Native update preflight

**Version / slug:** native-update-preflight
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** updater_review

## Summary of the change

Tier 1, reversible updater fix. `UpdateChecker.applyUpdate` and rollback prepare a separate candidate, verify its version, CLI startup and SQLite operation under the supervisor's Node runtime, then promote it. The previous active install remains untouched during preparation. The boot wrapper and supervisor restore it if promotion was interrupted. Tests cover failure and success, including the production update route and real CLI/native binding. One focused review round and one expected red test run preceded implementation. A local verify follow-up updated three existing test files after the first full verify.

## Decision-point inventory

- `UpdateChecker.applyUpdate` — modified — may promote and request restart only after candidate validation succeeds.
- `AutoUpdater.applyPendingUpdate` — passed through — a failed result retains pending update and prevents restart.

## 1. Over-block

A candidate CLI that cannot report its installed version, or a SQLite binding that cannot run with the supervisor's Node binary, is refused. This may hold back an otherwise partially usable update, but both are required for reliable agent startup and database services. A temporary launch restriction can also delay an update until retry.

## 2. Under-block

The preflight cannot prove every later server initialization path or external service will work. It does prove the specific native binding failure from Inspec, package presence, CLI startup, and expected version. An interruption between the two promotion renames leaves a previous-install backup; the boot wrapper and supervisor restore it before startup. If restoration itself is denied by the filesystem, the backup and candidate remain for repair rather than being erased.

## 3. Level-of-abstraction fit

This is a package activation invariant at the updater. The supervisor already chooses the Node executable and the active shadow path; the preflight uses those same values. A higher-level message or session gate would see the problem too late.

## 4. Signal vs authority compliance

Required reference: [signal-vs-authority](../../docs/signal-vs-authority.md).

- [x] No — this is hard-invariant validation of install viability before a restart, not a judgment about message meaning or user intent.

The actual child process executes the candidate and SQLite query; their success is direct evidence of startup viability. The updater remains the single promotion authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Package load, SQLite query, and version equality are enumerable installation invariants.

## 5. Interactions

- **Shadowing:** Validation occurs before promotion and before the existing migration and restart path.
- **Double-fire:** The existing AutoUpdater single-flight apply flag still prevents duplicate applies.
- **Races:** A candidate has a unique directory; retries reset it. The active path changes only after validation. The previous install is retained until promotion succeeds. Startup recovery covers the two-rename gap; the migration regenerates older boot wrappers with that recovery code.
- **Feedback loops:** Failure leaves the pending version and last error in the existing retry flow, rather than marking it applied.

## 6. External surfaces

All agents receiving the release use the safer update path. Failed updates remain visible in logs and updater status, and the existing notification says the agent remains on its current version. No new operator action or URL is added. The candidate and previous directories are local, transient installation state.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: each agent installation and Node ABI belong to one machine. Update status already reports per-agent failure; no new durable replicated state, topic transfer behavior, or URL is introduced. The existing update notice remains subject to the current one-voice route.

## 8. Rollback cost

Revert and release a patch. No schema or persistent state migration is needed. A candidate left by process interruption can be removed later without touching the active installation.

## Conclusion

The focused failure is prevented: failed native builds and failed runtime probes cannot promote the candidate or request an update restart. The review surfaced promotion interruption and in-place rollback hazards; both were addressed and tested. Clear to ship after re-review.

## Second-pass review

Initial independent review raised two concerns: interrupted promotion could leave the active path absent, and rollback still installed in place. The updater now retains a recoverable backup; startup paths restore it; rollback uses the candidate preflight. Re-review raised a rollout timing concern because old wrappers could still be installed before promotion; the updater now prepares and verifies recovery in the boot wrapper before the first rename, with atomic wrapper replacement. Independent reviewer concurs with the revised design and found no remaining blocker for the native rebuild/restart invariant. A failed cleanup of the previous backup can hold a later update, while the active install keeps serving.

## Local verify follow-up

The first full verify on the PR merge with main at `0aa1391` failed 21 unit cases. Five exposed test and registry inventory assumptions changed by this patch: the SQLite probe is a child process that closes its in-memory handle, rollback installs into a unique pending directory and reports that it kept the active install, and startup validation must now prevent promotion rather than warn. Those checks were updated to assert the new safety invariant. The other 16 failures were all in `telegram-origin/store-retention.test.ts`, a file unchanged by this PR and also failing in an unrelated PR verify; all 25 tests in that file passed when replayed on current main. The full local verify on the updated PR is the final gate.
