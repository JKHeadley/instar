# Side-Effects Review — Disk steward: busy deferrals do not trip the cleanup breaker

**Version / slug:** `disk-steward-busy-not-failure`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `independent subagent`

## Summary of the change

`DiskSteward.recordPrune` used to increment the auto-cleanup breaker whenever a live automatic run freed under 1% of the disk. A run whose only planned work was skipped as `npm-busy` or `xcode-busy` counted the same way. This change adds `onlyBusyDeferred(categories)`, which is true when every category with planned bytes was cut short with a `*-busy` skip. When it is true, the breaker is left unchanged: it neither rises nor resets. Every other run is judged by the old rule. This fixes fb-58754ac0-5e8: on the Studio, three busy skips on 2026-11-17 tripped the breaker, and auto cleanup stayed in dry-run through the 2026-11-18 critical episode with ~9.9 GB of npm cache still planned.

## Decision-point inventory

- **Breaker increment: invariant, a deterministic counting rule.** The change narrows what counts as a failed attempt. It adds no judgment.

## 1. Over-block

No issue identified. The change only stops one kind of non-attempt from counting as a failure.

## 2. Under-block

- **A run that is always busy never trips the breaker,** so the steward keeps scheduling attempts at its normal minimum interval (6 h). That is the intended behaviour. The busy checks themselves still protect npm and Xcode.
- **The npm cache is still never cleaned if npm is always running.** A wait-for-idle or quiet-hour pass would close that, and it is a separate change, noted in fb-58754ac0-5e8.

## 3. Level-of-abstraction fit

This is the right layer. The breaker decision lives in `recordPrune`, and the categories already report their skip reasons there.

## 4. Signal vs authority compliance

No new authority. The breaker's existing authority is narrowed to the case it was built for.

## 4b. Judgment-point check

Not a competing-signals point. The rule is deterministic.

## 5. Interactions

- **Breaker resets.** Episode start/end resets and manual runs are unchanged.
- **Interval.** A busy-only run still sets `lastPruneAt`, so the minimum interval between attempts still applies and there is no tight retry loop.
- **Tripped breakers.** On machines where the breaker is already tripped, it resets at the next episode boundary, as before.

## 6. External surfaces

None, beyond auto cleanup running live on machines where busy skips used to trip it.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (`machine-local-justification: hardware-bound-resource`). Each machine's steward manages its own disk.

## 8. Rollback cost

Revert the commit. There is no state migration, and the persisted breaker field keeps its meaning.

## Conclusion

A one-rule fix. Automatic disk cleanup no longer disables itself on machines where npm is always busy.

## Second-pass review (if required)

**Round 1 (independent subagent, 12:53 PT): Concur with the review.**
- The only `*-busy` values are `npm-busy` (returned before any delete) and `xcode-busy` (cut short partway). Neither carries an error. `budget` and `process-list-unreadable` still count as failures.
- Accepted edge case: a category that planned 0 bytes and errored, sitting beside an `npm-busy` category, no longer adds 1. It had nothing to free.
- `lastPruneAt` is still set, so the 6 h interval holds, with no loop or repeated notice.
- The test fails without the fix.
