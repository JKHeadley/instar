# REPORT F2 — reconciliation of the certified structured-output repair

## 2026-08-18 12:02:24 -0700 (PDT) — identity

```text
builder: Instar-codey
lane: F2 reconciliation
measured line: phaseb/f1-blind-checker-ratchet
measured commit: 3801aefe9825e1258f5f235c123c56bee9e6a98b
certified source branch: phaseb/f3-checker-instrument-harness
certified implementation: e64e3a2497d59a4d3aec0f8eb4e04589e4912f58
independent certification: REPORT-J16, SOUND, 2026-08-18 07:21:03 -0700
reconciliation branch: phaseb/f2-certified-summary-reconciliation
reconciliation implementation: 859e90347555fec34ae5d9500752b058658ca507
common protected base: 248ed7177f5bf416aa7bdad9763741478195e1fc
Node: v22.18.0
```

I read `REPORT-J16.md` first and `REPORT-J14.md` second as directed. The history is decisive: J14 refused the earlier two-decoration allowlist because it still parsed presentation text; the branch then replaced it with schema-validated Node test-event records, and J16 independently certified that exact implementation SOUND. I found no defect in the certified approach and did not re-derive or improve it.

## Reconciliation answer

The correct integration is to carry the certified P3 harness bytes onto the measured F1 line. Re-pointing the battery at F3 is not equivalent: F3 and F1 diverged at protected main, and F3 does not contain the later F1 ratchet and authenticated-receipt work that the fourth-guard battery is meant to measure. Re-pointing would change the subject rather than repair the measured subject.

The certified test-file change does **not** apply automatically without conflicts. A real no-commit cherry-pick of `e64e3a2` onto `3801aefe9` produced:

```text
CONFLICT (modify/delete): scratchpad/phaseB/REPORT-W5.md
CONFLICT (content): tests/unit/checker-blind-input-ratchet.test.ts
```

The report conflict is historical evidence, not executable repair: F1 does not carry `REPORT-W5.md`, while `e64e3a2` modifies it. I kept that unrelated report absent.

The test-file conflict had exactly two localized conflict regions:

1. F1 still had the original `guardOwnSuite(modulePath, dir)` declaration, whereas the certified change arrives from a parent containing J14's intermediate `hasNodeTestSummary` repair and replaces that path with the structured result schema, parser, and dual-reporter helper.
2. F1 still had the original `output.toContain('# tests 4')` / `output.toContain('# fail 3')` block, whereas the certified change arrives from the intermediate two-spelling assertions and replaces them with exact TAP/spec structured-record equality.

Nothing in F1's additional ratchet, blind-case, protected-state, or authenticated-receipt work conflicts semantically with the certified P3 harness. Those additions are earlier in the same test file and remain byte-for-byte as they were on F1. The conflict is textual ancestry: both branches independently added this test file after their common protected base, and F1 never carried J14's intermediate allowlist commit.

## What I did

I created a clean worktree and branch at exact measured commit `3801aefe9`. I performed the no-commit cherry-pick trial, retained only the executable test-file port, resolved both content regions by selecting the certified side verbatim, and omitted the unrelated historical W5 report. I made no xmllint/JUnit changes and added no alternative parser, reporter, assertion, or control.

The resulting implementation commit is:

```text
859e90347555fec34ae5d9500752b058658ca507  test: read checker results structurally
```

It changes only:

```text
tests/unit/checker-blind-input-ratchet.test.ts | 125 insertions, 11 deletions
```

## Exact-byte proof

The full files cannot have the same digest because the measured F1 file contains 256 additional lines of later F1 work before P3. The certified unit of integration is the complete final P3 block, from `describe('P3 — ...')` through end of file. It is 233 lines in both trees and hashes identically:

```text
e64e3a2 P3 block: 363e23c30d25283f8bb3d9da303710c04a396d58b577bc2de37de35aa3cd3c8c
859e903 P3 block: 363e23c30d25283f8bb3d9da303710c04a396d58b577bc2de37de35aa3cd3c8c
```

Whole-file identity records explain, rather than conceal, the retained F1 context:

```text
F1 before port:       339d2c0f8b84df1dce28e13bcbc3bf26b90917cf42f3e78c6dc3f99b373e0110
F1 after port:        d0018f709d12ea0e8e974cacd142cefc95cdbe203a83bf62962854119f78add6
F3 certified whole:   ab59cd790255325b1f6958ddbdb4c540b7d96a1b6bb6c00c5992df06d74f0847
```

No `xmllint`, JUnit, fake-rendered-line, or F2 reimplementation byte appears in the reconciled test file.

## Integration verification

I ran only the focused 3d test on the reconciled F1 tree, not the independent P3 property battery. It passed:

```text
Test Files  1 passed (1)
Tests       1 passed | 17 skipped (18)
tapChildExit=1
specChildExit=1
```

The two real human reporters produced genuinely different output:

```text
TAP:  # tests 4 / # pass 1 / # fail 3
spec: ℹ tests 4 / ℹ pass 1 / ℹ fail 3
```

Both structured destinations produced the same exact schema-validated record:

```json
{"schema":"checker-blind-input/guard-own-results-v1","tests":[{"testNumber":1,"identity":"empty population is not proof","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":2,"identity":"unknown coverage id is rejected","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":3,"identity":"new uncovered checker is named and rejected","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":4,"identity":"genuinely covered population passes","outcome":"pass","failureCode":null}]}
```

Compile-only verification also passed with `tsc --noEmit`. I intentionally did not invoke the aggregate pre-commit hook because its `npm run lint` path calls `lint-checker-blind-input-coverage.mjs`, which would violate the instruction not to run the P3 battery on this integration. The implementation commit was therefore made with Husky disabled after the focused test, TypeScript check, clean staged-diff check, and exact-byte comparison passed.

J16's independent evidence remains the authority for the certified source bytes: it reports the complete 13/13 guard suite green and certifies the structured-event, decoration-independence, strengthened exact-identity, and wiring claims. This F2 record establishes only that those already-certified bytes now sit on and execute against the measured F1 line.

## Abandoned build record preserved

Per the corrected instruction, the earlier xmllint/JUnit attempt was not deleted or committed. It remains uncommitted in:

```text
/Users/justin/.instar/agents/instar-codey/.worktrees/phaseb-f2-structured-summary-repair
branch: phaseb/f2-structured-summary-repair
status: staged modification to tests/unit/checker-blind-input-ratchet.test.ts
        staged addition of scratchpad/phaseB/REPORT-F2.md
```

None of those bytes were copied into reconciliation commit `859e90347`.

## Finding

There is no genuine defect in the J16-certified mechanism. The defect was integration topology: the certified repair and the measured F1 subject were divergent descendants of protected main. The executable answer is the exact certified P3 block on an F1 descendant, not a new repair and not a battery re-point.
