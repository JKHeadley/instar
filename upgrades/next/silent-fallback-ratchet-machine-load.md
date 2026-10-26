<!-- internal-only -->
## What Changed

**The silent-fallback ratchet is back at its baseline, so the merge queue moves again.**

`origin/main` measured 495 against a `BASELINE = 494` in
`tests/unit/no-silent-fallbacks.test.ts`, which only ever decreases. Because Local Verify
tests each PR as the merge of the PR and main, every queued PR inherited that failure — PR
#2371 reported `file-failed:tests/unit/no-silent-fallbacks.test.ts:1`, and PR #2350 reached
`gave-up / refused:verify-failed` after three attempts.

The flagged catch (`src/core/machineLoadReport.ts`, `sampleOnce()`) already logs its error
with the message, and a missed sample surfaces as `loadVerdict: 'unknown'` rather than a
fabricated healthy reading. It was missing the canonical in-window `@silent-fallback-ok`
justification, which this adds. One comment; no behaviour change; count returns to 494.

The baseline was deliberately NOT raised: the number is the mechanism.

## Evidence

- Same scanner, four trees: `c7feb1573` 493 · `origin/main` (`ebb9366f5`) 495 · this branch 494.
- `.instar/state/local-verify/journal.jsonl`: PR 2371 `lane-failed:unit:1`; PR 2350 `gave-up`.
- `tests/unit/no-silent-fallbacks.test.ts` passes (5/5) on this branch.
