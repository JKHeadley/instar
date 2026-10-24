# Side-Effects Review — feedback executor: attempt clones receive the base commit; a failed preparation stops the tick

**Version / slug:** `executor-clone-base-objects`
**Date:** `2026-10-23`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier 1 bug fix; no gate, authority or confinement change)`

## Summary of the change

Live incident, 2026-10-23 18:33 PDT (topic 18330): one executor tick claimed 8 work items in two minutes and every one ended `prepare-failed`. Reproduced by hand: `git clone` of the agent-home checkout copies only objects reachable from its branches and tags; the base is `origin/main`, a remote-tracking ref that no local branch contained after main moved past every local branch, so `git checkout --detach <base>` in the clone died with `fatal: unable to read tree`.

- `SafeAttemptGit.fetchBase` now fetches `+refs/heads/main` into both `refs/remotes/origin/main` and a local branch `feedback-execute/base` (`BASE_BRANCH`), and reads the base from that branch. The plain clone then carries the base's objects. Same verb (`fetch`), same read-tier opt-in, same hardened config.
- `startNew` stops claiming after the first preparation that returns false (any reason), so a machine-level fault spends one start and one item attempt, not every queued item's.
- `prepare-failed` detail: the triage audit keeps only id-shaped values, so the scrubbed message added in PR 2322 was recorded as `[text:300]`. The scrubbed message is now kept in executor meta `exec:prepare_failed_last` and exposed as `summary().lastPrepareFailure`; the audit row carries `step` (`prepareFailureStep`: fetch-base / checkout-base / clone / link-deps / evidence / other / unknown).

## Decision-point inventory

None added. `prepareFailureStep` is a deterministic label for observability; it decides nothing.

## 1. Over-block

The brake can delay a second candidate whose preparation would have succeeded (an item-specific failure). Cost: one tick (30 min). Preparation failures are machine-level in practice (clone, deps, sandbox), and the previous behaviour turned one fault into N failed items.

## 2. Under-block

None: no gate, allowlist, sandbox profile, publish or merge rule changes. The new local branch is written by the trusted server in its own checkout, never by a confined session.

## 3. Level-of-abstraction fit

The base-branch fix sits in the git port where the base is fetched; the brake sits in the claim loop beside the existing availability break; the detail uses the existing meta + summary pattern (`exec:canary_last`).

## 4. Signal vs authority compliance

Status and audit fields are signals. The brake only reduces actions.

## 4b. Judgment-point check

No judgment added.

## 5. Interactions

- `git branch` in the agent home now lists `feedback-execute/base`; it is force-updated to origin/main on every attempt. Nothing else reads it.
- Later clones (verify base clone, publish of a held change set) use the stored base SHA; main fast-forwards, so an earlier base stays reachable from the branch.

## 6. External surfaces

`GET /feedback-factory/execute/status` gains `lastPrepareFailure` (scrubbed, ≤300 chars). Additive.

## 7. Multi-machine posture

Per machine, as before: the executor runs on the lease holder against its own checkout.

## 8. Rollback cost

Revert the commit. The leftover local branch is harmless (`git branch -D feedback-execute/base`).

## Conclusion

Fixes the live failure with one refspec, bounds the blast radius of the next preparation fault, and makes its reason readable.

## Evidence pointers

- Hand reproduction: clone of the agent home at origin/main `230aa85ad` → `fatal: unable to read tree`; adding the fetch → checkout OK in 0.2 s.
- Tests: `execute-attempt-git.test.ts` (base only on origin/main still checks out; fails without the fix), `execute-reroute-capacity.test.ts` (one failed preparation per tick; `lastPrepareFailure` + audit `step`). Executor unit 145/145, integration 9/9, e2e 2/2, `npm run lint` clean.
