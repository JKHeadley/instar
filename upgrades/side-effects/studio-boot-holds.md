# Side-Effects Review — remove three event-loop and boot holds

**Version / slug:** `studio-boot-holds`
**Date:** `2026-11-06`
**Author:** `echo (builder echo-studio-stall)`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Tier 1, about 120 lines of source across 4 files plus tests. One PR at the hub's direction, in three independent parts. (1) `LocalVerifyService.rebuildIndex` reads open PRs with one `gh pr list` through a new optional seam `listOpenPrs`, falling back to per-PR `isPrOpen` when the list is null or throws; a full page counts as null. (2) `ProjectMapper.findRelatedWorktrees` reads branch and remote from `.git`, `HEAD`, `commondir` and `config` instead of running git twice per worktree. (3) `UpdateChecker` runs xattr and candidate validation asynchronously, so `validateCandidate` becomes async with its checks and order unchanged. Effort: one design pass, no spec rounds.

## Decision-point inventory

- `validateCandidate` (refuses a bad update): unchanged checks, timeouts and order; only async. Modified in mechanism, not in decision.
- `rebuildIndex` open/closed classification: same meaning, different source. It decides journal retention and index membership, not whether anything may merge. `restoreQueue` and request paths still read per-PR.
- No new decision point.

## 1. Over-block

No issue identified. A PR opened after the list call cannot be in the journal read at boot, because no verify for it has run. A PR reopened between list and use is corrected by per-PR reads on later requests.

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

- `rebuildIndex` also runs through `closedSeen` retention. A PR missing from a complete list counts as closed. A truncated page or failed call never starts retention expiry. One difference from the per-PR path: a journal PR number GitHub cannot resolve (a moved repository, say) used to read as unknown and was kept forever; it now counts as closed and leaves after the normal retention window, which is the better outcome for a record nobody can act on.
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

Safe to ship. It removes measured holds without changing any decision. It does not fix the unplanned restart under load: the exact stalls before 14:17:40 were not caught, and the steady sync tmux and ps load is filed separately.

## Second-pass review (if required)

Reviewer: independent subagent, read the diff without my conclusion. Found no promotion without validation, missing await or new update race. Raised six low-severity points: an inaccurate retention claim, a list call on an empty journal, quoted URLs, a reftable placeholder, a 120s xattr limit that could cut cleanup short, and an inaccurate claim that the map runs only at boot. All addressed in this change, or recorded above where the new behaviour is acceptable.

## Evidence pointers

Project map on the real agent home (490 related worktrees): old 41.4s and 51.1s; new 1.5s then 0.13s. Branch and remote matched real git on a random 25, 0 differences. Boot timings and the update stall are in the release note. Tests: `tests/unit/UpdateChecker-event-loop.test.ts`, `tests/unit/ProjectMapper-related-worktrees-no-git.test.ts`, `tests/unit/localVerify/serviceSeams-listOpenPrs.test.ts`, and additions to `tests/unit/localVerify/LocalVerifyService.test.ts`.

## Class-Closure Declaration (display-only mirror)

```json
{ "defectClass": "unbounded-self-action", "closure": "n/a",
  "reason": "One-shot per update attempt: two xattr passes, each time-limited, with no retry or loop. The update itself is unchanged." }
```
