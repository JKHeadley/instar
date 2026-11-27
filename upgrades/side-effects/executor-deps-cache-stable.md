# Side-Effects Review — Executor deps cache stable

**Version / slug:** executor-deps-cache-stable
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** independent Claude subagent (see below)

## Summary of the change
Tier 1, 1 runtime file plus unit coverage, about 35 runtime lines. The cache key drops the project's own version from package.json and package-lock.json, and native binaries can be copied from another ready cache with the same module version and Node ABI. Effort: no spec rounds.

## Decision-point inventory
- Cache identity — modify: the same dependencies at a different project version now share a cache.
- Native binary source — modify: adds other ready caches after the agent home.
- Base gate stamp — pass-through: keyed on the raw manifests through a separate `gateKey`, so it still reruns per release.

## 1. Over-block
No block/allow surface changed.

## 2. Under-block
A cache now outlives releases, so attempts run on one install longer, and a bad `.ready` cache no longer gets replaced by the next release; `sqlite-open` still fails on each attempt and latches, and nothing rebuilds until a dependency changes. I found no realistic way to produce one. The rebuild hang itself is not explained, because nothing was captured, and it can return when a rebuild is really needed (Node ABI change, module bump, or no ready cache). Any dependency, script or override change still changes the key, because only the root version fields are removed. A workspace package manifest change alone did not change the key before and still does not.

## 3. Level-of-abstraction fit
The key belongs in `DepsCache`. Fixing releases to leave the lockfile alone would be wider and would not cover the compile.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. No decision authority changed.

## 4b. Judgment-point check
None.

## 5. Interactions
The first run after install rekeys once and reinstalls, reusing the binary. The eviction rule, which keeps the two newest caches, is unchanged. Sources are the agent home, tried first, then caches this code built under the agent's own `.worktrees/.feedback-deps`, which attempt commands cannot write. The home candidate has no ABI check, which is existing behaviour; Echo's home has no such module. A copied binary skips the fix script's verification, and `sqlite-open` in the canary covers that on every attempt.

## 6. External surfaces
None. Less CPU and disk churn.

## 7. Multi-machine posture
Machine-local BY DESIGN: the cache and its binaries are per machine and per ABI.

## 8. Rollback cost
Plain revert, which rekeys the cache once more.

## Second-pass review
Concern raised, then addressed (independent subagent). It replayed the key across 460 releases with no change on any, found no way to install wrong dependencies, and loaded a copied binary successfully. It found the new key would have cut the base lint and smoke gate from per release to about every 5 days; a separate `gateKey` keeps it per release. It found my negative controls proved nothing (fixed so wrong sources sort first) and my causal claim overstated (corrected).
