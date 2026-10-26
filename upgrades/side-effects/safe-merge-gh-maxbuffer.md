# Side-effects review — safe-merge gh output ceiling

**Tier 1.** 1 script file (+13/-4 lines), 1 new test file. Effort: no spec rounds, first commit attempt.

## Summary

`scripts/safe-merge.mjs` spawned `gh` with Node's default 1 MiB `maxBuffer`. A large PR's
`pulls/N/files --paginate --slurp` answer (every file's patch) exceeded it, `gh` was killed with
ENOBUFS, and safe-merge refused the merge as `refused:contexts-unverifiable` (PR #2364: 94 files,
1.6 MB diff). Fix: every `gh` spawn uses one named option set with `maxBuffer: 256 MiB`. The
`gh()` helper is now exported and takes an injectable `spawn` (default `spawnSync`) so the test
can drive it with a real >1 MiB child process. No other behaviour changes. I considered
narrowing the file reads with `--jq` to filenames, and did not: `--slurp` cannot be combined
with `--jq`, so it would change the output shape that `checkLocalFloor`'s injected `ghJson`
(and its tests) parse, which is more than this fix needs.

## 1. Over-block
None. The change removes a false refusal; it adds no refusal.

## 2. Under-block
An answer above 256 MiB would still overflow and be refused as unverifiable, the same safe
direction as before. No real PR approaches that.

## 3. Level-of-abstraction fit
Right layer: the spawn options are the cause, and one shared constant covers all three gh
spawns, so a future call site has an obvious thing to reuse.

## 4. Signal vs authority compliance
No decision logic changes. safe-merge keeps its existing authority; this only stops a transport
failure from being misread as an unverifiable check. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions
The green-PR watcher and Local Verify merge line call safe-merge; they now get a real verdict
on large PRs instead of `contexts-unverifiable`. Memory: the buffer is a ceiling, not an
allocation; a normal answer uses what it needs.

## 6. External surfaces
None for users or other agents. GitHub sees the same requests.

## 7. Multi-machine posture
Machine-local by design: a CLI run on whichever machine merges; no state.

## 8. Rollback cost
Revert the commit. No state, migration or config.

## Second-pass review
Concur with the review.
- All three `'gh'` spawns (gh() at the helper, mergeAndConfirm, the auto-merge arm) use GH_SPAWN_OPTIONS; ghJson, ghText and fetchChecksRows all route through gh(), so the large `--paginate --slurp` reads (files, check-runs, workflow runs) are covered. The only other spawns (node for authToken, sleep) read tiny output.
- Exporting gh and adding the optional `spawn` param changes no CLI behaviour: every internal caller omits it and gets spawnSync. The isCliEntry guard is untouched, and the module was already imported by other unit tests without running main().
- Test runs green (4/4): test 1 shows the default buffer really ENOBUFS on 3 MiB, test 2 drives the real gh() with its real options through a >1 MiB child, test 3 keeps spawn errors throwing, test 4 pins every gh spawn to the shared options.
- The 8 answers are accurate (+13/-4 confirmed; `--slurp` with `--jq` is indeed rejected by gh api).
