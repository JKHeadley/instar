# Side-Effects Review — remove three event-loop and boot holds

**Version / slug:** `studio-boot-holds`
**Date:** `2026-11-06`
**Author:** `echo (builder echo-studio-stall)`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Tier 1, about 120 lines of source across 4 files plus tests. One PR at the hub's direction, in three independent parts. (1) `LocalVerifyService.rebuildIndex` reads open PRs with one `gh pr list` through a new optional seam `listOpenPrs`, falling back to per-PR `isPrOpen` when the list is null or throws; a full page counts as null. (2) `ProjectMapper.findRelatedWorktrees` reads branch and remote from `.git`, `HEAD`, `commondir` and `config` instead of running git twice per worktree. (3) `UpdateChecker` runs xattr and candidate validation asynchronously, so `validateCandidate` becomes async with its checks and order unchanged. Effort: one design pass, no spec rounds.

## Decision-point inventory

- `validateCandidate` (refuses a bad update): unchanged checks, timeouts and order; only async. Modified in mechanism, not in decision.
- `rebuildIndex` open/closed classification: same meaning, different source. It decides journal retention and index membership, and index membership is a merge-authority input: `getRecord` feeds `hasPassingRecord`, so the green-PR watcher, `StatusReconciler` and the `request()` short-circuits all read it. The safety argument is that both sides of the classification stay correct: a PR is indexed at boot only if a complete open list contains it or, when no complete list is available, its own read says OPEN, and a wrong "closed" costs a re-verify, never a merge. Merge inputs stay keyed to the exact head and base. `restoreQueue` and request paths still read per-PR.
- No new decision point.

## 1. Over-block

No issue identified. A PR opened after the list call cannot be in the journal read at boot, because no verify for it has run. A PR reopened between list and use has no record in the index until a new verify completes or the next boot, so `request()` runs a new verify. Its `closedSeen` entry also stays until the next boot, because only `rebuildIndex` clears it. That fails safe and matches the old path.

## 2. Under-block

The candidate checks are as strict as before. While they run the event loop is free, so other work proceeds, but nothing reads the candidate until promotion, which still follows validation.

## 3. Level-of-abstraction fit

Each fix is at the layer doing the work. The seam keeps GitHub access in `serviceSeams`. Reading git files in `ProjectMapper` is a small local parser, kept there because only this summary needs it; the map is informational and read-only.

## 4. Signal vs authority compliance

- [x] No: this change has no block/allow surface of its own. It keeps the update refusal exactly as it was and adds no brittle check with authority.

Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points added or changed.

## 5. Interactions

- `rebuildIndex` also runs through `closedSeen` retention. A PR missing from a complete list counts as closed. A truncated page or failed call never starts retention expiry. One difference from the per-PR path: a journal PR number GitHub cannot resolve (a moved repository, say) used to read as unknown and was kept forever; it now counts as closed and leaves after the normal retention window, which is the better outcome for a record nobody can act on. A second difference: on the per-PR path a transient `gh pr view` failure read as unknown and kept that open PR's record out of the index until next boot; on the list path the PR is indexed, so `hasRecord` can answer true where it did not before. That is correct, since the PR is open, but index membership is wider.
- `applyUpdate` was already async around npm steps, so overlapping-update handling is unchanged; validation adding awaits does not open a new kind of window.
- `withSyncOp` was removed from these calls because they no longer block.
- The xattr `spawn` is bounded: two per update, each with a 10-minute limit. It is not a loop or a retry. If the limit is hit, it warns and validation continues, so a candidate could be promoted with attributes unstripped; the old call had no limit and would have frozen the server instead. A boot wrapper guards against the crash loop that unstripped attributes can cause.
- Local-verify startup runs once at boot. The map runs at boot and on `GET /project-map` (when no saved map exists) and `POST /project-map/refresh`; those requests get the same speedup.

## 6. External surfaces

One `gh pr list` replaces up to 275 `gh pr view` calls at boot: fewer GitHub API calls. `project-map.json` keeps its shape. The `git remote get-url` path honoured `url.insteadOf` rewrites and config includes; a direct config read does not, so an agent using those sees the raw URL in the map. An unborn branch now reports its name where git failed and gave null. These are display-only in `relatedWorktrees`, with no decision reading them.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface changed. Faster boot means fewer 503 replies during restart.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine boots and updates itself, and these are local reads. Nothing replicated changes.

## 8. Rollback cost

A plain revert. No state format, migration or config changes.

## Conclusion

Safe to ship. It removes measured holds. The only decisions that change are the two named under Interactions: an unresolvable PR now counts as closed, and an open PR is no longer left out of the index by a transient read failure. It does not fix the unplanned restart under load: the exact stalls before 14:17:40 were not caught, and the steady sync tmux and ps load is filed separately.

## Second-pass review (if required)

**Reviewer:** independent subagent (echo-land-three, 2026-11-07), on the `src/localVerify` change at head 5dca1d998, with the author's review in hand, as the brief asked, tracing the code independently.

The verify record for that head was flagged as harness-changing, and the earlier review below no longer matched this file, so this review was run fresh. It traced `rebuildIndex` to its merge consumers, ran the list against real gh, compared list and per-PR state on the live journal (281 PRs, no disagreements) and found no way for this change to authorize a wrong merge. It raised concerns about this file's accuracy (the claim that the index does not affect merging, an unnamed second difference, the word "corrected") and missing tests (`--limit`, `closedSeen` on the list path). All were fixed here; 12 mutations of the code were each caught by the tests. Not confirmed: that gh always fails the whole call if pagination breaks partway. If it did not, the cost would be a re-verify and a retention clock the next complete list clears, not a false authorization. Also not observed: gh's real output for an empty list, which only a stub covers; an empty result is a complete answer, so the risk is low.

Earlier review, by an independent subagent who read the diff without my conclusion: Found no promotion without validation, missing await or new update race. Raised six low-severity points: an inaccurate retention claim, a list call on an empty journal, quoted URLs, a reftable placeholder, a 120s xattr limit that could cut cleanup short, and an inaccurate claim that the map runs only at boot. All addressed in this change, or recorded above where the new behaviour is acceptable.

## Evidence pointers

Project map on the real agent home (490 related worktrees): old 41.4s and 51.1s; new 1.5s then 0.13s. Branch and remote matched real git on a random 25, 0 differences. Boot timings and the update stall are in the release note. Tests: `tests/unit/UpdateChecker-event-loop.test.ts`, `tests/unit/ProjectMapper-related-worktrees-no-git.test.ts`, `tests/unit/localVerify/serviceSeams-listOpenPrs.test.ts`, and additions to `tests/unit/localVerify/LocalVerifyService.test.ts`.

## Class-Closure Declaration (display-only mirror)

```json
{ "defectClass": "unbounded-self-action", "closure": "n/a",
  "reason": "One-shot per update attempt: two xattr passes, each time-limited, with no retry or loop. The update itself is unchanged." }
```

## Later change: tests kept honest

Local verify failed three `tests/unit/UpdateChecker.test.ts` cases. They faked `execAsync` for every command; validation now goes through that helper, so the fake replaced the real node probes those tests exist to prove. They now fake npm only, so the real startup and native-module checks still run, and a loop advances fake timers until the call settles. No code changed.

`tests/integration/native-update-preflight.test.ts` needed the same change, found by the next Local Verify run. Five files fake this helper: the unit and e2e ones either never reach validation or were changed above.
