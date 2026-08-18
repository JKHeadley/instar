# Phase B Lane W4 — conversion of the two UNKNOWN wiring proofs

> **Append-only chronology:** entries are recorded in execution order. Task A was completed before Task B began.

## 2026-08-18 05:33:21 -0700 (PDT) — Task A: coverage claim

### Before

J7's hardened re-gate of PR #1922 at `c0e77e8e11000c54be1b96604752cdbd30eabc20` was **UNKNOWN**. Both pipeline passes stopped before the declared checker with zero observer lines because the protected pipeline rejected stale model-registry review metadata:

```text
FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window.
```

The instrument verdict line was:

```text
    "outcome": "unknown",
```

### Conversion attempt and after

PR #1922's branch `phaseb/f1-blind-checker-ratchet` was rebased cleanly onto server-fetched protected main `248ed7177f5bf416aa7bdad9763741478195e1fc`. Its new head is `3801aefe9825e1258f5f235c123c56bee9e6a98b`, and the branch was pushed with a lease pinned to the previously observed head. No model-registry manifest, freshness gate, CI configuration, checker, or test was changed.

The wiring-only proof used the unchanged certified PR #1924 instrument, SHA-256 `584a0a0b7248c4bede3f99e58f369db2183ca298fc5c1209862a6e3dc41edd72`, and the same manifest and adapter bytes J7 used. The protected lint pipeline now reached the exact declared checker and authenticated all three observer events, but the checker exited 1 and therefore minted no successful execution receipt. Its own Vitest fixture expected legacy Node test-runner summary text `# tests 4`; Node 25 emitted `ℹ tests 4`.

The new deciding line is:

```text
checker-blind-input: NOT-PROVEN — executable blind cases exited 1
```

The instrument verdict remains, verbatim:

```text
    "outcome": "unknown",
```

Task A after-verdict: **UNKNOWN**. Per the brief, the run stopped here; the pipeline was not massaged and the verdict was not promoted. Evidence: `scratchpad/phaseB/evidence/W4-checker-blind-input-coverage.json` (`4fa11fc9c00b40038e95ddca2445971b2be0604ccae3e060bb9823a94879aa4f`).

Could Task A make a genuinely wrong entry pass? **No.** The only branch change was rebasing the existing PR commits onto protected main. The certified instrument, declared entry, checker, pipeline, and all entry-matching behavior were unchanged for this measurement; the result stayed UNKNOWN.

## 2026-08-18 05:33:21 -0700 (PDT) — Task B: operator-binding claim

### Before

J7's hardened re-gate was **UNKNOWN** even though three observer events authenticated, because the live child used the `.bin` shim spelling and the manifest declared the module entry spelling:

```text
observed child pid was not the exact declared descendant process
```

The instrument verdict line was:

```text
    "outcome": "unknown",
```

### Precision fix

Only declared-entry path comparison changed. Both observed and declared spellings must resolve successfully through `fs.realpathSync`, and their resulting real-path strings must be exactly equal. Any resolution failure returns false. There is no prefix comparison, basename comparison, fallback lexical comparison, or other "close enough" direction. Authentication authority, signing, event sequence/identity checks, receipt binding, manifest, adapters, and enforcement-evidence logic were not changed.

Fixture deciding output:

```text
W4_POSITIVE shimRealPathEqualsModule=true authenticatedReceipts=1 verdict=PROVEN
W4_NEGATIVE symlinkTargetsDifferentSameNamedFile=true authenticatedReceipts=0 verdict=UNKNOWN
```

The positive fixture proves that a `.bin` symlink and module spelling of the same real file are accepted. The negative fixture makes a `.bin/vitest` symlink point to a different `vitest.mjs` in another directory; despite the same basename and successful wrapper exit, it receives zero authenticated receipts and the verdict is not promoted. A separate control proves two missing equal spellings, one missing side, and an empty side all refuse rather than match.

Focused suite:

```text
node --test scratchpad/phaseB/authenticated-execution-receipt.test.mjs scratchpad/phaseB/fix-verifier.test.mjs
tests=22 pass=22 fail=0
```

### After

The amended instrument SHA-256 is `e49d10fd4d98a93a8011efa6807d180cab56fdf5a7745744879bad7c0afb4897`. The wiring-only proof re-ran against J7's exact target `4318a1e150e9a8304e6c2e7ad381bf66d03998e5`, with protected main resolved to `248ed7177f5bf416aa7bdad9763741478195e1fc`.

The observed argv used the `.bin/vitest` spelling, all three observer events authenticated, the real child exited 0, exactly one authenticated child-exit receipt was minted, and C3 produced zero guard execution receipts. The instrument verdict line was, verbatim:

```text
[fix-verifier-wiring] authenticated guard=topic-operator-evidence entry=node_modules/vitest/vitest.mjs childPid=91450 childExit=0
```

Task B after-verdict: **PROVEN**, wiring-only rung **WIRED**. Evidence: `scratchpad/phaseB/evidence/W4-topic-operator-evidence.json` (`e3fedbdd72f6392615b18a6fee3dcce0bbbf527da96fb7cad5155c41001a07e0`).

Could Task B make a genuinely wrong entry pass? **No.** Successful equality requires both filesystem resolutions and exact equality of their canonical results. The wrong-target fixture is specifically a symlink plus same-named file in another directory—the two permissive mistakes this change could otherwise invite—and it stays UNKNOWN with zero receipts. Resolution failure is also explicitly refused.

## 2026-08-18 06:04:14 -0700 (PDT) — W4-R: regular-file identity repair

### Independent finding and correction

J8 demonstrated that the preceding “genuinely wrong entry” conclusion was incorrect. The comparator required equal canonical paths but did not require either resolved operand to be a regular file. Consequently a declared directory compared equal to itself while Node executed its contained `index.js`; the end-to-end control minted one authenticated receipt and returned `proven`. A symlink chain ending at a directory had the same defect. The earlier operator-binding run remains a real execution fact but its certification is inadmissible until this repair is re-proved.

The deciding J8 output was:

```text
[fix-verifier-wiring] authenticated guard=j8-directory-entry entry=entry-dir childPid=11777 childExit=0
{"directoryComparisonAccepted":true,"executedContainedFile":true,"wrapperExit":0,"authenticatedReceipts":1,"verdict":"proven"}
```

J8 names both consumers of the comparison: the parent-side authenticated `observer-ready` / `child-start` identity validation and the generated observer's target selection. The repair requires both canonical operands to pass `statSync(...).isFile()` before exact real-path equality can succeed in both locations. No authentication, signing, sequencing, receipt binding, manifest, adapter, or enforcement-evidence logic changed.

### Authenticated negative fixtures

The full observer/authority controls now exercise both omitted cases. In each case Node really executes the contained index file, but the generated observer emits no authenticated target events, the authority mints zero receipts, C3 emits no short-circuit, and the envelope remains `unknown`:

```text
W4R_DIRECTORY executedContainedFile=true authenticatedEvents=0 authenticatedReceipts=0 verdict=UNKNOWN
W4R_DIRECTORY_SYMLINK chainEndsAtDirectory=true executedContainedFile=true authenticatedEvents=0 authenticatedReceipts=0 verdict=UNKNOWN
```

The pre-proof focused suite passed 24/24:

```text
node --test scratchpad/phaseB/authenticated-execution-receipt.test.mjs scratchpad/phaseB/fix-verifier.test.mjs
tests=24 pass=24 fail=0
```

Pre-proof amended instrument SHA-256: `c9fab8034effc8f64c525073f85c7c04c1fd5cca9c0b2324203632ea34145b3a`.

Operator-binding certification status at this point: **UNKNOWN pending a fresh wiring proof with the repaired instrument**.

### Repaired operator-binding proof

At `2026-08-18 06:07:51 -0700 (PDT)`, the committed repaired instrument re-ran the same wiring-only operator-binding measurement against clean target `4318a1e150e9a8304e6c2e7ad381bf66d03998e5`. The protected base resolved to `248ed7177f5bf416aa7bdad9763741478195e1fc`; the target remained unchanged by measurement.

The real positive run authenticated three signed observer events and minted exactly one post-child receipt. C3 authenticated the observer short-circuit and minted zero guard execution receipts. The deciding verdict line, verbatim, was:

```text
[fix-verifier-wiring] authenticated guard=topic-operator-evidence entry=node_modules/vitest/vitest.mjs childPid=77868 childExit=0
```

After verdict: **PROVEN**, wiring-only rung **WIRED**. Unlike the superseded W4 certification, this result is admissible under the repaired regular-file identity predicate and the two authenticated negative fixtures.

Evidence: `scratchpad/phaseB/evidence/W4R-topic-operator-evidence.json` (SHA-256 `c877831e3e0d03621eb41469f82282af8168e7847f423c4dc3bf3963fe1f700c`). Instrument SHA-256: `c9fab8034effc8f64c525073f85c7c04c1fd5cca9c0b2324203632ea34145b3a`.
