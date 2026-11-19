# Side-Effects Review — The worktree reaper recognises a node_modules install a lockfile can rebuild

Spec: `docs/specs/reaper-node-modules-regenerable.md` (converged in 6 rounds; approved by the Chief of Staff, msg 8282ada7, 2026-11-18 21:27 PT, on the condition of a 30-manifest cap, removal of unneeded manifests, and their sizes reported). Stacked on #3490.

## Summary of the change

A checkout's real root `node_modules` can now pass, with the verdict `node-modules-residue`, when it is proven to match a reference install built from the same `package.json` and `package-lock.json`.

**New code:**
- `agentWorktreeNodeModules.ts` — the proof:
  - pinned-source checks (an `unsupported-source` keeps the checkout);
  - the classification order, including the `bin/` exception;
  - fstat-bracketed hashing;
  - the content-addressed residue store;
  - a per-pass verdict memo.
- `agentWorktreeReferenceBuildMain.ts` and `agentWorktreeReferenceBuilder.ts` — a niced reference-builder child and its supervisor:
  - `npm ci --ignore-scripts --offline`, with `scripts` stripped and `npm_config_ignore_scripts` plus `npm_config_offline` in its environment;
  - one build per pass, never during a reclaim;
  - 6-minute timeout, 3 GB free floor, 2 GB scratch ceiling, scratch cleaned on every exit;
  - backoff on failed builds;
  - a cap of 30 manifests, evicting those no checkout needs.

**Edits:**
- the reaper's classify, archive and clean checks;
- the link index: a root check over `git worktree list`, a fresh check at removal, and a re-read of deep links;
- the reclaim child: a post-rename re-stat, a `verified` row before any trash delete, and rename-back or `trash-held`;
- a guard restore direction;
- report fields;
- a self-action registry entry.

## Decision-point inventory

- **A real `node_modules` passes (invariant).** Every file matches by hash, or is archived and verified residue. Anything else, any error or any missing reference keeps the checkout.
- **Residue: archive or keep (invariant).** If free space would fall below the floor, the checkout is kept.
- **Reference build limits (judgment-candidates within floors, derived in the spec).**

## 1. Over-block

These are kept, as intended:
- pnpm installs and partial installs;
- `file:`, `link:` and remote-tarball dependencies;
- checkouts whose npm cache entries are gone;
- any changed shipped file.

## 2. Under-block

These residuals are stated in the spec:
- a hand-made link inside another checkout's `node_modules`, or from outside every known root;
- a writer with a file already open in the milliseconds after the post-rename check;
- a new deep link in lanes or deps folders within the same pass.

## 3. Level-of-abstraction fit

The proof is a module beside the reaper's git logic. The builder is a separate child, following the existing runner pattern.

## 4. Signal vs authority compliance

Removal authority stays with the fail-closed evaluation. The proof only adds a way for one entry to pass, and every failure keeps the checkout.

## 4b. Judgment-point check

The build limits are derived and fail safe: hitting one leaves the checkout kept or unchecked.

## 5. Interactions

- **Disk steward:** its npm cache prune can make references unavailable until sessions refill the cache. They are retried daily, and the cause is reported.
- **Removal child:** the reclaim child's time-left rule is per kind of checkout. The builder never runs during a reclaim.
- **No package code:** the build runs no package code and never goes online.

## 6. External surfaces

- **Network:** none. The build is offline only, from npm's local cache.
- **Report:** new verdict counts, residue bytes, manifest count and size, the scratch high-water mark, and the store size.

## 6b. Operator-surface quality

No new operator surface beyond the report fields.

## 7. Multi-machine posture

`machine-local-justification: hardware-bound-resource`. Each machine has its own disk and npm cache.

## 8. Rollback cost

Revert. With `dryRun: true` nothing is removed. The store under the archive directory is kept, as archives are never deleted. Manifests under the reaper state directory can be left in place.

## Conclusion

Safe to ship with removal off.

## Second-pass review (if required)

Required. An independent reviewer read the diff (2026-11-19 00:17 PT) and raised one concern. It is fixed:
- **Concern:** the reference build skipped lockfile entries not installed in its source checkout, so an uninstalled entry pointing at a non-GitHub git host could be cloned by `npm ci` even offline.
- **Fix:** the builder now calls `analyzeLockfile(..., { rejectUninstalledFetchable: true })`. An uninstalled entry that names a fetchable non-registry, non-GitHub source gives `unsupported-source`. An entry with no `resolved` (another OS's optional build) still passes.
- **Tests:** both cases are tested.

The reviewer's minor point is also fixed: the reclaim child decides the real-`node_modules` path from the disk as well, not only from the report field.

Found while re-running under load, also fixed: the builder cleared its running state before recording the outcome and deleting scratch, so a new build could have started while the old scratch was being deleted. The state is now cleared last, in a `finally`.

On the rest, the reviewer concurred:
- no path removes a hand-edited file;
- no package code runs;
- links are found;
- the cap and cleanup hold;
- there is no new main-thread work;
- dry-run removes nothing.

## Evidence pointers

| Test file | Passed |
|---|---|
| `agent-worktree-node-modules-compare` | 17/17 |
| `agent-worktree-node-modules-store` | 7/7 |
| `agent-worktree-node-modules-reaper` | 18/18 |
| builder plus existing reaper files | 81/81 |
| integration `agent-worktree-node-modules-live` | 2/2 |
| self-action convergence for `worktree-reference-build-spawn` | 11/11 |

tsc is clean, and `run-lint-parallel` passes 54 of 54.

## Class-Closure Declaration (display-only mirror)

Class: unbounded-self-action. Closure: guard. The new `worktree-reference-build-spawn` controller is registered in the self-action convergence ratchet: at most one build per pass, with a real backoff.
