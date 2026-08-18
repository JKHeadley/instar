# W3.6 — renderer-independent structured test observation

## 2026-08-18 07:05:18 -0700 — final targeted hand verification

```text
$ npx --yes node@25.6.1 node_modules/vitest/vitest.mjs run --config vitest.push.config.ts tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit 0
W36_C1 source="node:test TestsStream" misleadingRendererCounts=ignored mutationLanded=true cleanExit=0 cleanTests=1 mutatedExit=1 mutatedTests=1 confirmationExit=0 confirmationTests=1 failureKind=assertion artifact=authenticated verdict=ratchet
Test Files  1 passed (1)
Tests       15 passed (15)
Duration    2.40s

$ ASDF_NODEJS_VERSION=20.11.1 npm run test:push -- tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose -t "C3a keeps|C1 promotes"
exit 0
Test Files  1 passed (1)
Tests       2 passed | 13 skipped (15)

$ npx tsc --noEmit
exit 0
(no output)

$ git diff --check
exit 0
(no output)

$ shasum -a 256 scripts/lib/standards-enforcement-node-test-runner.mjs
0b67bd259c7cd078ab4feba10a814e9c6007a210c40b98a2382042b2feb36cc1  scripts/lib/standards-enforcement-node-test-runner.mjs
```

Live Node 25.6.1 measurement remains honest-and-empty because protected main has no execution plans:

```text
exit 0
protected=88 candidate=88 continuity=88
ratchet=0 gate=0 lint=0 spec-only=0 documented-only=88
unverifiedReferences=254
```

Fixture discrimination is now established even though the live population remains empty. This changes the mechanism from honest-and-empty to demonstrably discriminating on a qualifying protected plan; it does not manufacture live numerator evidence.

## 2026-08-18 07:00:04 -0700 — J13 fault reproduced and repaired by source substitution

### Pinned subject

```text
branch: phaseb/w36-structured-test-counts
W3.5 judged head: dd43fa7297b5d1ce044902ee460602b59816e9fb
protected main at branch creation: 248ed7177f5bf416aa7bdad9763741478195e1fc
```

### Before — environment-dependent suite reproduced before editing

The W3.5 author run used Node 22.18.0:

```text
$ ASDF_NODEJS_VERSION=22.18.0 npm run test:push -- tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit 0
Test Files  1 passed (1)
Tests       15 passed (15)
Duration    4.38s
```

The exact J13 runtime reproduces the judge's disagreement:

```text
$ npx --yes node@25.6.1 node_modules/vitest/vitest.mjs run --config vitest.push.config.ts tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit 1
cleanExitCode=0 cleanTestsRun=null
mutatedExitCode=1 mutatedTestsRun=null
confirmationExitCode=0 confirmationTestsRun=null
reason="protected-execution-proof-not-proven:clean observer did not pass executed tests"
Test Files  1 failed (1)
Tests       4 failed | 11 passed (15)
Duration    5.07s
```

Node 22's non-TTY default emitted TAP `# tests` summaries. Node 25.6.1 emitted the newer information-glyph renderer. W3.5 parsed the former text despite never pinning that renderer, so both reports were accurate for their environments; the suite itself was environment-dependent.

### Source chosen

The authority source is now the `TestsStream` returned by programmatic `node:test.run()`. A verifier-owned runner counts non-skipped, non-suite `test:pass` and `test:fail` events, finds assertion failures from the structured error/cause object, and sends one exact-schema record to the verifier over the child IPC channel. The verifier rejects missing, duplicated, or malformed observations as UNKNOWN. No TAP/spec/dot/glyph line or human-rendered assertion text feeds counts, failure kind, or promotion.

The protected execution-plan runner identity is now `node-test-events-v1`, with stable entry path `scripts/lib/standards-enforcement-node-test-runner.mjs`. The actual child argv remains H1 receipt-bound. This lane changed only the standards measurement path and its fixtures; it did not touch the fourth guard or W4 entry-comparison logic.

### After — exact judge runtime discriminates

The positive observer deliberately prints contradictory fake summaries (`# tests 999`, `# pass 999`, `# fail 0`, and `ℹ tests 999`). Structured events still report exactly one real test per run:

```text
$ npx --yes node@25.6.1 node_modules/vitest/vitest.mjs run --config vitest.push.config.ts tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit 0
W35_C3A ... cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C3B ... cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C3C ... cleanExit=0 mutatedExit=1 confirmationExit=1 property=NOT-PROVEN deciding="discrimination-did-not-reset"
W35_C3D ... property=UNKNOWN deciding="clean observer execution timed out"
W36_C1 source="node:test TestsStream" misleadingRendererCounts=ignored mutationLanded=true cleanExit=0 cleanTests=1 mutatedExit=1 mutatedTests=1 confirmationExit=0 confirmationTests=1 failureKind=assertion artifact=authenticated verdict=ratchet
Test Files  1 passed (1)
Tests       15 passed (15)
Duration    3.50s
```

Answer to the whole question: **yes, a genuine observer now reaches proven ratchet on Node 25.6.1, while the vacuous and mutation-surviving observers remain NOT-PROVEN.**

Affected coverage entry path on Node 25.6.1:

```text
$ npx --yes node@25.6.1 node_modules/vitest/vitest.mjs run --config vitest.push.config.ts tests/unit/standards-coverage-ratchet.test.ts --reporter=verbose -t "passes on a fully-guarded fixture|C3a refuses to improve the headline|C3b drops a protected ratchet reference|C3c does not count a new rule"
exit 0
Test Files  1 passed (1)
Tests       4 passed | 34 skipped (38)
Duration    61.60s
```

State: BUILT WITH HAND EVIDENCE, not independently judged and not machine-verified. No FIXED or EFFECTIVE claim; pull request only, no merge.
