# Side effects: the reaper's registry-copy proof works inside real agent worktrees

## Summary of the change
`registryCopyIsCommitted` (src/monitoring/agentWorktreeGit.ts, spec reaper-generated-files-regenerable, PR 3480) proved that `src/data/standards-registry.md` is an unmodified generated copy by running `git hash-object` through the reaper's read path (`SafeGitExecutor.readSync`). Inside every real agent worktree (a checkout of the instar source) the source-tree guard REFUSES `hash-object`, the call threw, the proof returned false, and the copy was classed `work`. Result on the Studio (measured 2026-11-19 ~14:10 PT): 227 of 305 worktrees kept as `uncommitted-changes`; for 45 of them the registry copy was the only thing the reaper counted as work (~16 GB apparent). The unit fixture was not a source-tree checkout, so the tests never saw the refusal.
Fix: compute the copy's git blob id in-process with git's own formula (`"blob <size>\0" + bytes`, SHA-1, or SHA-256 when the repo's id for HEAD:docs/STANDARDS-REGISTRY.md is 64 hex) and compare it with the committed id from `rev-parse` (which the guard allows). The proof is the same equality as before; only how the copy's id is obtained changes. No git command is added.

## Decision-point inventory
- Registry copy classification (regenerable vs work) — modify: the approved rule now actually runs.

## 1. Over-block
Before: every source-tree worktree over-blocked (kept) because of a refused command. After: none from this cause.
## 2. Under-block
The equality is unchanged: a copy differing by one byte is still `work` (test). A symlinked copy is still `work`. A missing/odd committed id still fails closed (`work`).
## 3. Level-of-abstraction fit
Fix sits in the one function that does the proof.
## 4. Signal vs authority compliance
The reaper's verdicts are unchanged in kind; the reaper is dry-run on the Studio and removal stays gated by merged + not-in-use + the rest of isClean.
## 5. Interactions
Worktrees newly classed clean still need `isMerged` and `!isInUse` before they are eligible. With 3490 (out-of-process removal) they would be removed by the child after rename-to-trash; the reaper is in dryRun on the Studio, so nothing is removed until that is switched (a separate decision).
## 6. External surfaces
GET /worktrees/agent-reaper will show more eligible worktrees and a larger projection.
## 7. Multi-machine posture
Machine-local by design (hardware-bound-resource): each machine's own worktrees.
## 8. Rollback cost
Revert the commit; classification returns to always-work for the copy.

## Tests
tests/unit/agent-worktree-reaper-generated-files.test.ts: new case "proof holds inside a source-tree checkout" (writes the `.instar-source-tree` marker, asserts `hash-object` is refused, asserts regenerable for an exact copy and work for a one-byte change). Fails on the old code (1 failed / 27 passed), passes on the new (28/28). Related: agent-worktree-reaper, -off-thread, no-silent-fallbacks, standards-registry-asset: 146/146. tsc clean. Live read-only check on Studio worktrees with the built fix: echo-wm-report-cap and echo-disk-recovery-once isClean true (were false); echo-admission-refused-replace-first stays false (real node_modules).

## Second-pass review (Codex, independent, read-only)

Concur with the review. Blob formula matches git hash-object --no-filters for empty/text/binary/registry content; rule unchanged (exact equality only; symlinks/non-plain files and failures stay work); test exercises the real SafeGitExecutor with production flags. Suggestion applied: the test now asserts the specific source-tree refusal.
