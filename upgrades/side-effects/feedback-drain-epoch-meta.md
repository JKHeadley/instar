# Side-Effects Review — feedback drain: the recorded owner epoch follows the live owner epoch

**Version / slug:** `feedback-drain-epoch-meta`
**Date:** `2026-10-01`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Live defect on the Mac Studio, found during `feedback-readiness-demotion` (#2108). The drain DB's `drain_meta.owner_authority_epoch` is `1` while the drain runs at coordinator lease epoch 22677+. The value was written once on 2026-08-28, when the drain ran in single-machine mode at `localOwnerEpoch = 1` (the only checkpoint manifest, `feedback-drain-checkpoint.json`, records epoch 1). The coordinator was enabled later. Every later write compared the recorded epoch for exact equality and never advanced it. Result: the hourly `checkpointForBackup` throws `backup owner authority epoch is stale` (no fresh backup checkpoint since August, so the spec's RPO ≤ 1 hour is not met), and `pruneOperationalHistory` throws `owner authority epoch is stale` after every non-degraded run. A consumer `claimNext` would throw the same way once the consumer goes live.

Two fixes:

1. `FeedbackDrainStore.ts`: `assertOrInitializeOwnerAuthorityEpoch` becomes `advanceOwnerAuthorityEpoch`. It is used by `claimNext`, `pruneOperationalHistory` and `checkpointForBackup`. A newer live epoch moves the recorded epoch forward and writes an `owner-epoch` audit row (`from → to`, reason `owner-epoch-advance`). An equal epoch is a no-op. An older epoch is refused as stale, exactly as before. Invalid epochs (< 1, non-integer) are refused as before.
2. `AgentServer.ts`: in single-machine mode `localOwnerEpoch` started at 1 on every boot. After a finalized restore (epoch bumped to N+1) a restart presented 1 again, which the store refuses as stale (and which the old exact check also refused). It now starts from the store's recorded epoch (`store.ownerAuthorityEpoch() ?? 1`).

Existing stores self-heal on the next fenced write (the next run's prune, or the next hourly checkpoint). No migration and no operator action are needed.

## Decision-point inventory

- Owner-epoch fence on store writes (`claimNext`, `pruneOperationalHistory`, `checkpointForBackup`) — modify — exact match → monotonic (advance on newer, refuse older).
- Single-machine owner epoch at boot (`AgentServer`) — modify — constant 1 → recorded epoch.
- `assertCurrentClaim` (settle with token + epoch) — unchanged: still an exact match against the recorded epoch, so advancing the epoch supersedes every older claim.
- `finalizeRestore` and `restorePending` — unchanged.

---

## 1. Over-block

The old code over-blocked every legitimate epoch increase: a coordinator lease re-acquire, the switch from single-machine to coordinator mode, and a single-machine restart after a restore. That is the live outage. After this change the only refused epochs are older than the recorded one, which is what "stale writer" means in the spec (monotonically increasing `authorityEpoch`; stale owner epochs cannot mutate).

## 2. Under-block

- A writer at a NEWER epoch is now admitted where the exact check refused it. Who can present an epoch at all is unchanged: the service only runs on the canonical owner (`isCanonicalOwner` = configured operated host + coordinator lease, and no pending restore), and nonowners proxy. In coordinator mode the epoch is the coordinator's monotonic lease epoch, so a newer epoch is by construction the current lease holder, and every claim from the older epoch can no longer settle (`assertCurrentClaim` compares against the recorded epoch).
- Restore detection does not depend on the epoch fence. `restorePending()` runs at boot, compares the DB file identity (inode + birth time) against the checkpoint manifest, and blocks the writer (`isCanonicalOwner` false) until the PIN-gated `finalizeRestore`. A restored file that does not match its checkpoint throws. The integration test restores both the healed snapshot (detected, finalized to 22678) and the pre-heal epoch-1 bytes under the newer manifest (refused).
- Residual gap: a DB file swapped in with NO checkpoint manifest present is not detected by `restorePending`. In coordinator mode the old exact check refused claim/prune/checkpoint on such a file when its recorded epoch was older; the new code advances it (old claims are still fenced out, but `drain_owner_continuity` is not reset). In single-machine mode the old check caught nothing (the epoch was always 1). The spec's restore procedure always carries the manifest, so this path is outside the spec; it is named here rather than closed.
- A coordinator whose lease epoch went backward (lease state reset) is now refused as stale until its epoch passes the recorded one. That fails closed, as the spec's monotonic epoch requires.

## 3. Level-of-abstraction fit

The store owns durable epoch state and already fenced on it; the advance sits in the same helper. The server only seeds its local epoch from the store, the same place it already resets it after a restore.

## 4. Signal vs authority compliance

Deterministic fence logic over integers. No judgment, no model.

## 4b. Judgment-point check

No new heuristic at a competing-signals point.

## 5. Interactions

- `drain_owner_continuity` (#2108 readiness tenure) is keyed on the live owner epoch and run history, not on `owner_authority_epoch`. Unaffected.
- `finalizeRestore` requires the coordinator epoch to equal `restored + 1`. Checkpoints now record the live lease epoch, so a coordinator-mode restore needs the lease at the checkpoint's epoch + 1. This constraint already existed; it simply could not be reached before because no checkpoint could be written.
- One audit row per epoch advance, i.e. per coordinator lease re-acquire (live: 22677 → 22679 across 2026-09-30/10-01). Audit rows are pruned at 400 days. Once the consumer is live, a re-acquire mid-claim strands that claim until the lease reconciler requeues it; that was already true (the service's `assertOwner` aborts on an epoch change).
- Follow-up, not in this change: `finalizeFailoverRestore` in coordinator mode requires the live lease epoch to equal the checkpoint epoch + 1. Checkpoints now record the live lease epoch, which keeps climbing, so a coordinator-mode restore would usually stay restore-pending until that rule is relaxed. The rule predates this change (it was unreachable because no checkpoint could be written). Single-machine restore is unaffected and covered by the e2e test.
- `simulateClaims` runs on an in-memory copy and is unaffected.

## 6. External surfaces

None changed. `/feedback-factory/drain/status` and the dashboard stop reporting the post-run prune failure; the hourly checkpoint warning in the server log stops.

## 6b. Operator-surface quality

No operator surface changed.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the drain DB lives only on the operated host. In a mesh the epoch comes from the coordinator lease, which is monotonic across machines, so a takeover at a higher epoch advances the record and fences out the older owner. In single-machine mode the epoch now survives restarts.

## 8. Rollback cost

A code revert. On the old code a healed store (recorded epoch now equal to the live lease epoch) keeps working until the next lease re-acquire, then fails as before. No data is rewritten.

## Conclusion

Root cause: the recorded owner epoch was write-once and exact-matched, so it could never follow the coordinator lease. It now moves forward with the live owner and still refuses anything older. Backups and post-run pruning resume on the next run with no operator action.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only)
**Independent read of the artifact:** concur, with wording corrections

The reviewer found no path where a stale writer, a foreign machine, or a restored DB can mutate the drain against the spec: every epoch-writing caller is behind `isCanonicalOwner()` (which includes `!restorePending`), `finalizeRestore` and `assertCurrentClaim` stay exact, and `LeaseCoordinator.getLeaseEpoch()` is monotonic (max of own and peer-observed epochs). Corrections applied: §2 now states what the old check caught in coordinator mode for a manifest-less DB swap; §5 gives the measured re-acquire rate; the coordinator-mode restore successor rule is logged as a follow-up.

## Evidence pointers

- Live store (read-only): `drain_meta.owner_authority_epoch = 1`; `drain_runs` at owner epoch 22677; checkpoint manifest `ownerAuthorityEpoch: 1`, created 2026-08-28T01:40:46Z.
- Replay on a copy of the live DB (`sqlite3 .backup`), same calls the live drain makes, host `m_03b30f…`: origin/main throws on `checkpointForBackup(22677)` and `pruneOperationalHistory(22677)`; this change heals 1 → 22677, prunes, refuses 22676 as stale, advances to 22679 on a re-acquire, integrity ok, `restorePending` false.
- Tests: `tests/unit/feedback-drain-store.test.ts` (live shape 1 → 22677, superseded claim, stale refusal, audit row), `tests/integration/feedback-drain-backup-restore.test.ts` (heal then restore detected; pre-heal bytes refused), `tests/e2e/feedback-factory-drain-lifecycle.test.ts` (restart after a restore bump keeps epoch 2; fails on the pre-fix `AgentServer`).

## Class-Closure Declaration (display-only mirror)

Runtime code defect, not an agent-authored artifact. Class: a durable fence value that is write-once while its source advances. The sibling sites of the same value (`claimNext`, `pruneOperationalHistory`, `checkpointForBackup`, the single-machine boot epoch) are all closed in this change; `assertCurrentClaim` and `finalizeRestore` intentionally stay exact.
