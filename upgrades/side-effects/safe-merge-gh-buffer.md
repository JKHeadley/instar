# Side-Effects Review — safe-merge reads gh output up to 64 MiB

## Summary of the change

`scripts/safe-merge.mjs`: new exported constant `GH_MAX_BUFFER_BYTES` (64 MiB) passed as `maxBuffer` to the two `spawnSync('gh', …)` calls (the shared `gh()` helper and the merge call). New test `tests/unit/safe-merge-gh-buffer.test.ts`.

## Decision-point inventory

None changed. safe-merge's refusals and its merge decision are computed from the same answers by the same code; this change only lets a large answer be read.

## 1. Over-block

Removes one: a green, authorized large PR was refused `contexts-unverifiable` because the answer overflowed the default 1 MiB cap (PR 2900, PR 3053). Adds none.

## 2. Under-block

No issue identified. A larger buffer cannot turn a refusal into a merge by itself: every answer that is now readable goes through the same checks, and an answer that is still unreadable (gh missing, network failure, over 64 MiB) still throws and still refuses.

## 3. Level-of-abstraction fit

The cap belongs at safe-merge's `gh()` helper, which every read in this file goes through, plus the separate merge spawn. The constitution-pairing reads use their own helper in `scripts/check-constitution-pairing.mjs`, which already carries a 64 MiB cap. A streaming reader would remove the cap entirely; not warranted for answers of a few megabytes.

## 4. Signal vs authority compliance

Not applicable: no detector or gate is added or changed.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point. The cap is a resource bound, not a behavioural limit: basis external-constraint; evidence: Node's `spawnSync` requires a finite `maxBuffer`, GitHub's largest observed answer here is single-digit megabytes, and exceeding the cap fails closed (refusal), never open.

## 5. Interactions

`GreenPrAutoMerger` runs the installed safe-merge as a child with its own deadline and kill; memory for one merge attempt can now reach tens of megabytes transiently instead of failing at one. The watcher's own gh reads (`src/core/githubRuntime.ts`) already use a 32 MiB cap and are not touched.

## 6. External surfaces

None. Same CLI, same result JSON, same exit codes.

## 6b. Operator-surface quality

No operator-facing surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable: a standalone script run by whichever machine holds the merge credential; no state, notice or URL.

## 8. Rollback cost

Revert the commit; large PRs go back to being refused.

## Conclusion

Behaviour-preserving repair of a false refusal.

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the diff, the new test and this file, not the author's conclusions; read-only (no test run)

One read. It listed every child-process call in safe-merge and the modules it imports and found no remaining default-buffer GitHub read; confirmed no code path relied on the ENOBUFS error or on truncated output (the helper throws on `r.error` before stdout is used, and every catch refuses), so a readable answer goes through the same checks; found the merge spawn's handling of a spawn-level error unchanged and less likely to trigger; judged memory not a risk (a ceiling, sequential calls); confirmed all three test cases fail on the old code and the test's import and `__dirname` use are valid here; and confirmed `scripts/safe-merge.mjs` is NOT in the Local Verify verifier-version hash (it is loaded only through a non-literal dynamic import from wiring, which is not a root), so shipping this does not invalidate green records. Notes, all taken: section 3 said every read goes through one helper (the pairing reads use a second helper that already has the cap; corrected); section 5 named a watcher incident it could not confirm (replaced with the verifiable fact); the test's guard is a one-line pattern over this file only, so it does not cover a multi-line call or a call in an imported module (stated here rather than overclaimed); the merge spawn ignores `m.error` (pre-existing, not changed). Final line: "Concur with the change".

## Evidence pointers

- `.instar/state/green-pr-automerge.json` episode for 3053 on 2026-11-15: `attempts: 3, state: gave-up, lastOutcome: refused:contexts-unverifiable`.
- Hand run before and after the change, same PR, same minute: `gh spawn failed: spawnSync gh ENOBUFS` then `refused:body-checks … decision-audit: uncovered: src/data/awareness/instar-documents.md`.
