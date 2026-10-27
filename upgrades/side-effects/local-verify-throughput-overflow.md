# Side-Effects Review — a merge-throughput PR is admitted past a full verify queue

**Version / slug:** `local-verify-throughput-overflow`
**Date:** `2026-10-27`
**Author:** `Echo`
**Second-pass reviewer:** `independent cross-model reviewer (see below)`

## Summary of the change

Amendment to `docs/specs/local-verify-merge-authority.md` (built 2026-10-27). Operator request (Telegram topic 130715).

- `src/localVerify/policy.ts`: `LOCAL_VERIFY_LIMITS.throughputOverflow = 5` (not in the policy hash: admission only).
- `src/localVerify/LocalVerifyService.ts`: `capFor(priority)`; `request()` admits a labelled PR past `queueCap` while the PR queue is below `queueCap + throughputOverflow` (audit `queue-full-throughput-admitted`), a repair candidate first keeps its own admission and audit; a kept-place re-queue (pushed head) is never refused for capacity; boot restore brings back every durably queued entry up to that bound + 1 (the interrupted run); the re-run-after-green pass keeps its ordinary-cap skip (a refused request would spend the PR's one re-run).
- Agent awareness: template line + content-sniffed migration line.

## Decision-point inventory

- `request()` queue-full admission — modify — labelled PRs get a bounded overflow.
- Restore cap — modify — bounded by the overflow cap for every entry.
- Ordering, merge predicate, safe-merge — pass-through, unchanged.

## 1. Over-block

None.

## 2. Under-block

- The queue can hold up to 15 PR entries (10 + 5 labelled). Bounded; the starved alarm and aging are unchanged. Anyone who can label a PR can use the overflow; the label is set by the agent or operator who opened the PR, the same trust as the label's priority.

## 3. Level-of-abstraction fit

The admission decision sits where the cap is enforced today, beside the repair-candidate exception.

## 4. Signal vs authority compliance

The label orders and admits verifies; it never changes a verdict or a merge decision.

## 4b. Judgment-point check

None added.

## 5. Interactions

- Main-red hold: repair candidates keep their own unbounded admission; a labelled non-repair PR admitted past the cap is still held by the hold like any other PR.
- Restore: entries come back in file order up to the overflow bound, so no ordinary entry queued below the cap is dropped.

## 6. External surfaces

New audit event `queue-full-throughput-admitted`; `POST /local-verify` answers `queued` instead of `queue-full` for an admitted labelled PR.

## 6b. Operator-surface quality

Nothing new to read or tap.

## 7. Multi-machine posture

Machine-local, like the queue.

## 8. Rollback cost

Revert; a queue longer than 10 at the next restore is trimmed to 10 by the old code (its `queue-full` drop, audited).

## Conclusion

Lets the label do what it was built for when the queue is full, with a fixed bound.

## Class-Closure Declaration (display-only mirror)

No self-triggered action added: admission of an explicitly requested verify.

## Second-pass review

Concurred. Independent cross-model reviewer (Codex, read-only), three rounds:
- Round 1 BLOCKED: (1) a pushed head re-queued in its kept place could be refused while the overflow was in use — a kept-place re-queue is now never refused for capacity; (2) a restart with a run in flight and the overflow full dropped one entry — the restore bound is cap + overflow + 1; (3) a labelled repair lost its `queue-full-repair-admitted` audit — repairs are classified first; (4) the re-run pass and its bounds needed tests.
- Round 2 BLOCKED: routing the re-run pass through `request()` past the ordinary cap could spend a PR's one re-run on a refusal — the pass keeps its original ordinary-cap skip.
- Round 3 **CLEAN**.
