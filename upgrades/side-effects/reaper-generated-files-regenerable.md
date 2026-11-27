# Side-Effects Review — Worktree reaper archives the repo's own generated files

**Version / slug:** `reaper-generated-files-regenerable`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Spec:** `docs/specs/reaper-generated-files-regenerable.md` (converged in 4 rounds; approved by the Chief of Staff, msg 8a629537)
**Second-pass reviewer:** `independent subagent` (required: a deletion gate)

## Summary of the change

`agentWorktreeGit.ts` gains two classes for ignored entries:
- **`regenerable`:** `src/data/standards-registry.md` when its blob hash equals `HEAD:docs/STANDARDS-REGISTRY.md`;
- **`archived-residue`:** a closed list of generated files, `.husky/_/` children, and `.instar/audit/*.jsonl{,.1}`, regular files only, with folder entries read one level deep.

`isClean` treats `archived-residue` like gate records. `preserveGateRecords` archives the residue before removal: a chunked copy to a temp name, a hash from the same read, verify, then rename; it unlinks on failure. It refuses when free space is not larger than the residue, or when an audit-log dir sits inside the checkout. It returns a manifest.

A final re-check between preserve and `git worktree remove` re-lists, re-hashes, and reads fresh process scans (`cwdRootsFn`, `commandLinesFn`, not the 10 s cache). It throws, which keeps the checkout, on any difference.

The reaper report adds `archiveBytes`, per-worktree `node_modules` kind, and dry-run projections (residue and reclaim bytes; `unknown` if unmeasurable).

The default stays `dryRun: true`.

## Decision-point inventory

- **Ignored entry: regenerable / archived-residue / work.** Invariant; it gates an irreversible removal. Proof is at git level, or the bytes are preserved; anything else is `work`.
- **Archive may proceed against free space.** Invariant; the copy must fit.
- **Final re-check.** Invariant; any manifest, hash or process change keeps the checkout.

## 1. Over-block

Checkouts with a real `node_modules`, `logs/`, or any unlisted ignored file are still kept. This is intended, and the reaper's prior behaviour.

## 2. Under-block

An outside process writing a residue file between its last hash and the end of `git worktree remove` loses those bytes. This is the accepted residual named in the spec, the same window gate records already have.

## 3. Level-of-abstraction fit

The change sits in the reaper's own classifier and its existing preserve-then-remove path. There is no new deletion path.

## 4. Signal vs authority compliance

These are deterministic, fail-closed gates on an irreversible action. Byte or git proof, or preservation, is required. There is no judgment at the deletion point.

## 5. Interactions

- **Orphaned-work sentinel.** `orphanedWorkGit.ts` calls `isClean`, so it no longer counts archived residue as uncommitted work. This matches how it already treats gate records, and the residue is generated or audit output, not authored work.
- **Archive.** It grows by the archived residue, measured at about 1.6 MB per worktree, and is never pruned, in line with Archiving May Never Mean Deleting. It is visible as `archiveBytes`.
- **Off-thread dry-run pass (PR 3449).** It computes the same fields in the worker. Removal still runs only on the main thread.
- **Live removal.** It remains off. The CoS's recorded condition is that the synchronous fresh scans per removal move off the main thread, or the per-pass cap drops, before live removal.

## 6. External surfaces

- The reaper report JSON gains the new fields.
- `preserveGateRecords` returns a manifest instead of a count. It is an internal function; callers are updated.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local-justification: hardware-bound-resource`. Each machine classifies, archives and removes its own checkouts on its own disk.

## 8. Rollback cost

Revert the commit. Removal is dry-run, so nothing was deleted. Archived files, if any came from a live run on a test agent, stay in the archive.

## Class-Closure Declaration

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a` (negative declaration)
- **Reason:** this changes classification and the existing preserve step inside the reaper's existing pass. It adds no new loop, retry or self-triggered action. Its cadence, `maxReapsPerPass` and breaker are unchanged, and it stays dry-run.

## Conclusion

The reaper can tell generated and audit files from work, preserving them byte for byte, so merged checkouts held only by them become eligible in the report. Live removal stays a separate decision.

## Second-pass review (if required)

**Round 1 (independent subagent, 19:43 PT): concern raised.**
1. Ignored gate records got their manifest hash from a second read after the copy (`agentWorktreeGit.ts` ~568), so a record rewritten between the two reads passed the final re-check. Fixed: each record's hash now comes from the same read that wrote its archive copy (`recordHashes`).
2. The existing real-git tests in `tests/unit/agent-worktree-reaper.test.ts` let the new fresh process scan read the machine's real process list. Both test files name a checkout `merged`, so they collided when run together, and one test failed. Fixed: those 21 real-git `makeAgentWorktreeReaperDeps` calls now inject `cwdRoots`/`commandLines`, as the other tests already do. The two files run together pass 128/128, and tsc is clean.

The reviewer found the deletion gate otherwise sound: the folder expansion, the registry proof, the re-check list and dry-run, with real `node_modules` and unlisted files still kept. It confirmed the orphaned-work side effect is as stated.

**Round 2 (same reviewer, 19:52 PT): Concur with the review.** Both fixes were verified at file:line. The two unit files run together pass 128/128, and tsc is clean.

## Follow-up: registry location from the resolver (2026-11-18, LV failure 07:26Z)

`tests/unit/standards-registry-asset.test.ts` requires that exactly one module, `standardsRegistryPath.ts`, names the registry asset. The residue list named `src/data/standards-registry.meta.json` literally. It now takes `GENERATED_STANDARDS_REGISTRY_OUTPUTS[1]` from the resolver, the same value. Behaviour is unchanged, with no new runtime surface; the sections above stand.
