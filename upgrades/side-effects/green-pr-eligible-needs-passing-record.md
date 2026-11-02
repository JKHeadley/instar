# Side-effects review: only a passing verify record makes a PR merge-eligible

## Change
`src/localVerify/localVerifyWiring.ts` adds `hasPassingRecord(svc, pr, head, base)` (true only for `outcome === 'success'`); `src/commands/server.ts` wires the green-PR watcher's `hasRecord` through it. Before, `!!svc.getRecord(...)` counted a FAILED record as "has a record".

## Evidence
On the Studio (2026-11-02 22:13 UTC) the watcher's acting pass picked #2567, whose local verify had failed, as the oldest eligible PR; safe-merge refused it (`refused:verify-failed`), the tick ended, and the PR entered the retry ladder at the front of the line. Under the local floor safe-merge already refuses any non-success record, so every such attempt was a guaranteed refusal that cost a tick and an episode attempt.

## 1. Over-block
None: a PR with a failed record could never merge (safe-merge refuses it). It now waits as `no-verify-record` until a new head is verified.

## 2. Under-block
None new.

## 3. Level-of-abstraction fit
The watcher's eligibility read is where "verified" is decided; safe-merge stays the act-time authority.

## 4. Signal vs authority
Narrows candidacy only; never widens what can merge.

## 5. Interactions
`requestVerifies` still runs over all candidates, so a failed PR's new head still gets verified. For an unchanged failed head it now asks every tick; `LocalVerifyService.request` returns the existing failure record (`recorded`) without queuing anything, so the cost is three GitHub reads and one `verify-requested` audit row per failed PR per tick, and no test run. The red-PR watchdog reads GitHub check state, not this flag.

## 6. External surfaces
Fewer refused merge attempts in the audit log.

## 7. Multi-machine posture
Runs on the lease holder, as before.

## 8. Rollback cost
Revert.

## Class closure
unbounded-self-action: n/a. Narrows an existing selection; adds no action.

## Second-pass review
Concur with the review. `hasRecord` is consumed only by `GreenPrAutoMerger.recordFor` (acting pass, hand-off, not-agent-owned audit label, `requestVerifies`); nothing relies on a failed record counting as true. The change only narrows (`classifyCandidate` requires `hasRecord === true`; safe-merge already refused failed records). No re-verify loop: a non-explicit request on a failed same-head record returns `recorded` early. The per-tick read cost noted in section 5 is from this review.
