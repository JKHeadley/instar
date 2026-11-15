# The merge tool no longer chokes on large changes

<!-- bump: patch -->

## What Changed

`scripts/safe-merge.mjs` ran every `gh` call through `spawnSync` with Node's default 1 MiB output cap. For a large PR GitHub's answer is bigger (the files list with patches, a long review history); `spawnSync` then fails with `ENOBUFS`, the review precheck cannot read its own answer, and safe-merge refuses with `refused:contexts-unverifiable`. The auto-merger retried three times and gave up on a green, authorized PR (PR 2900 on 2026-11-08, PR 3053 on 2026-11-15). The real reason safe-merge had for PR 3053 (a decision-audit gap) only appeared once the call could complete.

Both `gh` spawns now pass `maxBuffer: GH_MAX_BUFFER_BYTES` (64 MiB, exported). No decision logic changes: the same checks run on the same answers.

## What to Tell Your User

Nothing changes for you. A large change that had passed its tests could be left unmerged with a reason that explained nothing; the merge tool now reads the full answer and either merges or says what is actually missing.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| safe-merge handles PRs whose GitHub answers exceed 1 MiB | Automatic |

## Evidence

- `tests/unit/safe-merge-gh-buffer.test.ts`: the cap's bounds; every `spawnSync('gh'` line passes it; 2 MiB of child output is `ENOBUFS` under the default and reads fully under the cap.
- Live, 2026-11-15, `node scripts/safe-merge.mjs 3053 --squash --admin`: before, `refused:contexts-unverifiable` with detail `gh spawn failed: spawnSync gh ENOBUFS`; after, `refused:body-checks` naming `decision-audit: uncovered: src/data/awareness/instar-documents.md`.
