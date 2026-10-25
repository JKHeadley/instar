## What Changed

- **The green-PR watcher merges again.** Its act-time re-read of a pull request asked `gh` for a field it does not have (`mergeCommitOid`); `gh` rejected the whole read, the watcher took the failure for a deleted PR, and every pull request was skipped as "vanished" — nothing was armed or merged (found 2026-10-24 with PR #2334 green and unmerged). The read now asks for `mergeCommit` and keeps the same returned shape.
- **A bad field can no longer silently disable the watcher.** The two `gh --json` field lists in the wiring are pinned by a unit test to the fields gh 2.97.0 supports (a constant check, no network), and a runtime `Unknown JSON field` answer is reported once per field through the degradation reporter and the watcher log, naming the field, before the read still fails toward not merging.

## What to Tell Your User

Nothing to do. If one of my green pull requests sat unmerged over the last day, that was this: my merge watcher could not read any pull request and treated them all as gone. It reads them again now and will pick those up on its next pass. Nothing was merged that should not have been.

## Summary of New Capabilities

- Degradation feature key `GreenPrAutoMerger.refetchPr.unknownJsonField` (one report per rejected field per process).
- Exported pins in `src/monitoring/greenPrAutomergeWiring.ts`: `GH_PR_JSON_FIELDS`, `REFETCH_PR_JSON_FIELDS`, `LIST_PR_JSON_FIELDS`, `reportUnknownGhJsonField`.

## Evidence

- `tests/unit/green-pr-automerge-wiring.test.ts` (mergeCommit.oid mapping, null merge commit, projections ⊂ known fields, live calls carry the pinned lists, unknown-field exit reports once and returns null, ordinary failure reports nothing)
- Live: `gh pr view 2334 --json mergeCommitOid` → `Unknown JSON field`, exit 1; `--json mergeCommit` → `{"oid":…}`. `logs/green-pr-automerge.jsonl`: `skipped:vanished` for 2334 at 2026-10-25T02:05:15Z.
