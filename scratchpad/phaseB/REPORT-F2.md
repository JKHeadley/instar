# Phase B Lane F2 — blind-input case diagnosis

> **Append-only chronology:** diagnosis was recorded before any checker, case, or harness source was changed.

## 2026-08-18 05:46:09 -0700 (PDT) — diagnosis before repair

### Cause in one sentence

The five executable blind cases all run and correctly refuse their blind inputs; the suite exits 1 because the coverage harness's separate P3 type-preserving-hollow self-test hard-codes legacy Node test-summary text (`# tests 4` / `# fail 3`), while Node `v25.6.1` emits semantically equivalent spec-reporter lines (`ℹ tests 4` / `ℹ fail 3`).

### Classification and scope

This is **HARNESS failing to run/interpret its case**, not a checker accepting blindness and not an unrelated dependency/environment failure. The process, Vitest, `vite-node`, production checker imports, filesystem fixtures, and all ten control/blind child executions work. The environment exposes a portability bug in the coverage change's own assertion, but does not fail independently of it. The cause is inside `tests/unit/checker-blind-input-ratchet.test.ts`, so the brief permits a repair. It is not a finding: the property does hold in every declared blind case.

The targeted Vitest case `executes every declared blind case and none reports clean` passed with one test passed and 17 skipped. A contemporaneous `better-sqlite3` native-module notice explicitly said it was non-gating; none of these cases uses sqlite and no deciding output names it.

### Declared cases and direct deciding output

Every case has a clean control and an intentionally blind input. A child exit 0 means the independent oracle saw clean for the control or non-clean for the blind phase.

1. `detector:src/monitoring/HumanAsDetectorLog.ts`
   - Demonstrates: a writable capture sink is clean; a persistence-write failure must be recorded rather than silently accepted.
   - Control actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"detector:src/monitoring/HumanAsDetectorLog.ts","phase":"control","passed":true,"evidence":[]}
     EXIT=0
     ```
   - Blind actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"detector:src/monitoring/HumanAsDetectorLog.ts","phase":"blind","passed":true,"evidence":[{"source":"test","topicId":29723,"messageId":null,"category":"factual-correction","reason":"persistence-write-failed"}]}
     EXIT=0
     ```

2. `probe:src/monitoring/probes/GuardPostureProbe.ts`
   - Demonstrates: readable local/peer posture is clean; unavailable local posture plus a failed peer deep read must return NOT-PROVEN rather than no anomaly.
   - Control actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"probe:src/monitoring/probes/GuardPostureProbe.ts","phase":"control","passed":true,"evidence":{"passed":true,"description":"No guard-posture anomalies across machines","diagnostics":{"unknownSources":[]}}}
     EXIT=0
     ```
   - Blind actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"probe:src/monitoring/probes/GuardPostureProbe.ts","phase":"blind","passed":true,"evidence":{"passed":false,"description":"Guard-posture NOT-PROVEN — 2 source(s) could not be inspected","error":"local: posture unavailable; blind-peer: deep read failed: unreachable"}}
     EXIT=0
     ```

3. `reviewer:src/core/reviewers/standards-conformance.ts`
   - Demonstrates: valid provider results may conclude fit; provider failure must degrade both review and fit judgment to not-proven.
   - Control actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"reviewer:src/core/reviewers/standards-conformance.ts","phase":"control","passed":true,"evidence":{"report":{"conclusion":"fits","degraded":false},"fit":{"verdict":"fit","reason":"control","degraded":false}}}
     EXIT=0
     ```
   - Blind actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"reviewer:src/core/reviewers/standards-conformance.ts","phase":"blind","passed":true,"evidence":{"report":{"conclusion":"not-proven","degraded":true,"degradeReason":"error"},"fit":{"verdict":"not-proven","reason":"fit judgment errored — not proven","degraded":true,"degradeReason":"error"}}}
     EXIT=0
     ```

4. `script:scripts/lint-checker-blind-input-coverage.mjs`
   - Demonstrates: a readable repository yields a non-empty checker population; a missing repository root must be rejected rather than treated as empty/clean.
   - Control actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"script:scripts/lint-checker-blind-input-coverage.mjs","phase":"control","passed":true,"evidence":{"population":96}}
     EXIT=0
     ```
   - Blind actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"script:scripts/lint-checker-blind-input-coverage.mjs","phase":"blind","passed":true,"evidence":{"rejectedMissingRoot":true}}
     EXIT=0
     ```

5. `script:scripts/lint-llm-attribution.js`
   - Demonstrates: a readable clean file yields no findings; an unreadable/missing input must be classified as blind rather than omitted as clean.
   - Control actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"script:scripts/lint-llm-attribution.js","phase":"control","passed":true,"evidence":{"real":[],"allowlisted":[],"stale":[],"blind":[]}}
     EXIT=0
     ```
   - Blind actual:
     ```text
     CHECKER_CHILD_RESULT {"id":"script:scripts/lint-llm-attribution.js","phase":"blind","passed":true,"evidence":{"real":[],"allowlisted":[],"stale":[],"blind":[{"reason":"file-unreadable: ENOENT"}]}}
     EXIT=0
     ```

### Actual failing boundary

The failure is in the later P3 harness fixture, not in `CASES`:

```text
P3_3d_TYPE_PRESERVING_HOLLOW mutationApplied=true guardOwnTestExit=1
ℹ tests 4
ℹ pass 1
ℹ fail 3
AssertionError: expected '✖ empty population is not proof ...' to contain '# tests 4'
```

The isolated hollow guard was correctly rejected: its own test process exited 1, three assertions failed, and assertion-failure output was present. Only the reporter-prefix assertion failed. Therefore the pre-repair coverage verdict remains:

```text
checker-blind-input: NOT-PROVEN — executable blind cases exited 1
```

## 2026-08-18 05:53:23 -0700 (PDT) — repair and authenticated rerun

The only source repair is in the coverage harness: its P3 type-preserving-hollow fixture now recognizes both TAP (`# tests` / `# fail`) and Node spec-reporter (`ℹ tests` / `ℹ fail`) summary lines while still requiring the isolated guard-own process to exit nonzero and expose assertion failures. No checker behavior, declared blind case, authentication, instrument, enforcement-evidence logic, model registry, CI configuration, or approver key changed.

Post-repair verification:

- `tests/unit/checker-blind-input-ratchet.test.ts`: 18/18 passed, including all five declared executable blind cases and all four P3 guard sabotages.
- Normal commit gate: passed, including TypeScript and the repository lint chain.
- Original certified H1 instrument SHA-256: `584a0a0b7248c4bede3f99e58f369db2183ca298fc5c1209862a6e3dc41edd72`.
- Target commit: `f7cd56fdf5abd1289022499a124421e7ca622ca0`.
- Protected base resolved to `upstream/main` at `248ed7177f5bf416aa7bdad9763741478195e1fc`.
- Evidence: `scratchpad/phaseB/evidence/F2-checker-blind-input-coverage.json` (SHA-256 `b7a9ab3c6a5e295a343a27bb20ab0559be389fe479bde7380a0ba0fa0cbdc749`).
- Positive run authenticated exactly one post-child receipt; C3 authenticated its short-circuit and minted zero guard receipts; the target worktree remained unchanged by measurement.

Before verdict:

```text
checker-blind-input: NOT-PROVEN — executable blind cases exited 1
```

After deciding verdict line, verbatim:

```text
[fix-verifier-wiring] authenticated guard=checker-blind-input-coverage entry=scripts/lint-checker-blind-input-coverage.mjs childPid=32717 childExit=0
```

After evidence verdict: `wiring.outcome=proven`, `rung=wired`.

Final classification: **HARNESS BUG FIXED**. The blind-input property itself held before and after the repair; the earlier `NOT-PROVEN` was caused solely by reporter-specific interpretation in the coverage test harness.
