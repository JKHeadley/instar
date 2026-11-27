# Side-Effects Review — Executor git non-blocking

**Version / slug:** executor-git-nonblocking
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** independent Claude subagent (see below)

## Summary of the change
Tier 1, 1 runtime file plus unit coverage, about 25 runtime lines. Fetch, clone, checkout, add and push in `SafeAttemptGit` run through `SafeGitExecutor.spawn` instead of `execSync`. Effort: no spec rounds.

## Decision-point inventory
- `SafeGitExecutor` guards — pass-through: spawn applies the same verb classification and source-tree checks.

## 1. Over-block
No block/allow surface changed.

## 2. Under-block
Other synchronous work remains in the tick. A reviewer measured, once at load about 35: `rmSync` of one clone 11.6 s, with `cleanup()` removing up to six trees, against 69 s plus 22 s for the clone and checkout now moved off the loop. Tree removal is the largest remaining freeze and is filed separately. This does not fix CPU saturation, and a causal link to the lease lapses is not proven. `spawn` records `allowed` at start and no failure row, so failed fetches and pushes drop out of the git audit trail; the executor's own audit still records the failure.

## 3. Level-of-abstraction fit
A small helper in the executor's git port, the only caller set with long-running commands here. `SafeGitExecutor.spawn` is the existing funnel.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. No decision logic changed.

## 4b. Judgment-point check
None.

## 5. Interactions
The event loop now runs during these commands, so other handlers can interleave with a tick. The tick stays exclusive through `this.running`, and writes remain fenced. An owner change can now be observed during these steps. In preparation the epoch carry handles it. During a push it is not carried: a later write is refused and the row parks as publish-outcome-unknown, which is safe, and that window already existed around PR creation. The timeout sends SIGTERM as before, rejects without waiting for the error pipe to close, and sends SIGKILL after a 5-second grace. A timeout message now reads `Command failed: git ...` with `timed out after N ms` instead of `spawnSync git ETIMEDOUT`; nothing matches the old text. A leftover credential helper can outlive a timeout. On server shutdown a running git child is orphaned instead of being waited for; the next boot treats the row as interrupted.

## 6. External surfaces
None beyond the server staying responsive.

## 7. Multi-machine posture
Machine-local BY DESIGN: git runs where the attempt runs.

## 8. Rollback cost
Plain revert.

## Class-Closure Declaration (display-only mirror)

unbounded-self-action: n/a. Each spawn is one git command inside the existing bounded attempt path, whose attempts remain capped per day. It does not retry, and the kill only ends that same child after its timeout. Not a self-triggered loop.

## Second-pass review
Concern raised, then addressed (independent subagent). It confirmed the guards match and found no credential leak or new tick reentrancy. It found by measurement that the timeout did not bound the command when a helper held stderr (25.4 s against a 4 s limit), which could wedge the executor; fixed with a test. Its vacuous timeout test and several inaccurate sentences here are corrected. Remaining: tree removal is synchronous (filed).
