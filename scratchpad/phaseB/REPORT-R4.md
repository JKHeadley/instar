# REPORT R4 — structured Codex smoke acceptance

## Result and severity

**Built and verified on branch `phaseb/r4-structured-codex-smoke`. This is a consistency repair, not a security repair.**

The legacy Codex smoke expectation failed closed. A cosmetic change that removed the word `PASSED` made an otherwise successful, exit-0 run fail its gate; it could not turn a failure green. The smoke producer already exits non-zero for missing credentials, rejected credentials, an evaluation failure, empty output, and a top-level crash. The old substring therefore added presentation brittleness, not safety.

R4 removes the partial-repair shape left after R2: all three acceptance siblings now consume structured output instead of leaving this one on the legacy text sentinel.

## Base premise re-derived

Construction base: `07011763580d2b76df5290e39b684f43f46ab8c1`
(`phaseb/r2-acceptance-population-assertions`). Before publication, the single R4 commit was
replayed onto canonical main commit `00f0111fd19050528dc708196c3451cae4ec8935` so the pull request
would not carry deletions from its older stacked history.

I invoked the exact R2 output evaluator with the old `expectStdoutContains: "PASSED"` contract and held the simulated runner exit at zero:

```text
R4_PRE_FIX original="[openai-codex smoketest] PASSED" legacyGate=PASS runnerExit=0
R4_PRE_FIX cosmetic="[openai-codex smoketest] completed successfully" legacyGate=FAIL runnerExit=0
```

The observed refusal reason was `expected stdout to contain "PASSED"`. This confirms the low-severity premise: cosmetic wording alone could block the old gate, while it could not produce a false green.

## Chosen repair

I chose the structured-contract route rather than deleting the output assertion.

Deleting the substring would have been defensible because source inspection confirmed that exit 0 is reached only after a non-empty live response. The existing R2 JSON consumer made a stronger consistency repair small, however: the smoke producer can now state the same success fact as a versioned receipt, and the acceptance manifest can compare exact typed fields independently of prose.

In `--json` mode the smoke producer now:

- routes human diagnostics to stderr;
- writes exactly one JSON document to stdout on success;
- creates no success receipt for empty text; and
- emits schema `instar-codex-smoketest/v1` with exact success fields:

```json
{"schema":"instar-codex-smoketest/v1","status":"passed","responseNonEmpty":true}
```

The Phase 4 manifest replaces `expectStdoutContains: "PASSED"` with `expectJson` over `status: "passed"` and `responseNonEmpty: true`. It invokes the TypeScript producer through the repository's lock-approved `vite-node` entry instead of asking `npx tsx` to resolve an undeclared package. No dependency was added or installed.

The ordinary no-flag smoke command remains human-readable and still ends with `[openai-codex smoketest] PASSED` on success. That output is now presentation only, not acceptance authority.

Every terminal path sets `process.exitCode` and returns instead of forcing `process.exit()`. This
lets Node drain redirected stdout and stderr before natural termination; the acceptance receipt is
therefore not vulnerable to machine-dependent truncation immediately after it is written.

## Fail-closed producer boundary

The exact finished producer has these terminal paths:

| condition | exit | structured success receipt |
| --- | ---: | --- |
| credentials absent | 2 | none |
| credentials rejected | 3 | none |
| other evaluation error | 1 | none |
| response text empty | 3 | none |
| uncaught top-level crash | 2 | none |
| non-empty live response | 0 | exact v1 receipt |

The missing-credential path was executed against the finished producer with `OPENAI_API_KEY` removed and an explicit empty `CODEX_HOME`. It exited 2 and reported `BLOCKED`; it produced no success receipt. The other exit classifications above are direct source inspection, not claims that R4 induced every live provider failure mode.

R4 did not make a live paid/provider call. The task is the acceptance contract, and the positive producer bytes are exercised through the same reporter used by the CLI. This report does not refresh or replace the manifest's historical live-API evidence.

## Controls — both directions observed

Each controlled runner wrote and verified an execution marker before its gate result was asserted. Both deciding negative controls C1 and C2 deliberately exited zero, so their refusal comes from the new structured comparison rather than the exit-code check.

```text
R4_C1 runnerExecuted=true runnerExit=0 legacySentinel=true repairedGate=FAIL
R4_C2 runnerExecuted=true runnerExit=0 status=failed repairedGate=FAIL
R4_C3 runnerExecuted=true runnerExit=3 receipt=valid repairedGate=FAIL
R4_C4 runnerExecuted=true runnerExit=0 receipt=valid legacySentinel=false repairedGate=PASS
```

- C1 proves old `PASSED` prose is no longer sufficient.
- C2 proves a structured non-success cannot pass even when exit code lies with zero.
- C3 proves a non-zero process cannot pass by printing a valid-looking receipt.
- C4 proves exact structured success passes without the cosmetic word `PASSED`.

Additional producer controls observed that empty text creates neither a receipt nor stdout, JSON-mode informational prose goes only to stderr, and human-readable mode retains its existing success line.

Two boundary controls added during the independent side-effects pass execute child processes. One
observed the exact JSON receipt on stdout and a diagnostic on stderr before a natural exit 0. The
other ran the finished CLI with an empty credential home, observed both diagnostics, no stdout, and
exit 2. A production-manifest control reads `phase-4.json` itself and requires the real
`codex-smoketest` gate to invoke `--json`, carry the exact schema and fields, and omit the legacy
`expectStdoutContains` sentinel.

Final focused run, with cache disabled:

```text
Test Files  2 passed (2)
Tests       13 passed (13)
```

Those thirteen tests include all nine R4 producer/gate/wiring tests and the four inherited R2
population controls, confirming both the production wiring and the sibling repair behave as
certified.

Additional finished-byte checks:

- TypeScript `--noEmit`: exit 0.
- Phase 4 manifest JSON parse: exit 0.
- `git diff --check`: exit 0.
- Finished producer missing-credential control: exit 2, no success receipt.

One earlier focused Vitest invocation did not start tests because Vite could not create its transient config bundle under the sandboxed worktree. It is recorded as an environmental startup refusal, not a test result. The exact focused command then ran with worktree write access and passed; no assertion failure was retried.

## Instrument identity

The inherited R2 consumer was not modified:

- `scripts/check-phase-complete.cjs`: SHA-256 `8711dfcd88fdf6cfe6007377ed61cb51dcdbf1bb491996f2379f083da7470fdd`;
- `scripts/lib/phase-acceptance-output.cjs`: SHA-256 `4bbb16459a26fd574391cfe901831c4d5a97e6306ee930479172ffb92855168e`.

| changed file | base SHA-256 | finished SHA-256 |
| --- | --- | --- |
| `specs/provider-portability/acceptance/phase-4.json` | `a4d9fc01cae1f7cf5ed184ee5e1b78851e2a5c513dde650b140922ae04f803e2` | `f42d6890a12f1bfa4d0569cfd0d3ba00206618f2438b770a9f0cdde4aa38440b` |
| `src/providers/adapters/openai-codex/_smoketest.ts` | `74833906460a05d21296b47d2504d5dbbe2dae3dcf61e378f3377bed5b150c66` | `a19a21e01a20202c572bdfc324cd07d62888c0f0bb2b13bcfc4bb2b0d4c4a867` |
| `src/providers/adapters/openai-codex/smoketest-result.ts` | absent | `c9315c518cf5efcde6b0a5d6d6d28237729513915ed2a44e2a0b4351122cbf` |
| `tests/unit/phase-acceptance-smoketest.test.ts` | absent | `f256355f3ea47aaa98b110218f59aaeb5a523ef00fea9b39669fe7b8396fbed0` |

## Dependency and cache record

No install or rebuild ran.

1. **Outer-instrument dependency root, symlinks resolved:** `/Users/justin/Documents/Projects/instar-codey/.worktrees/audit-j6-main-20260818/node_modules`.
2. **Measurement dependency root, symlinks resolved:** the same directory.
3. **Lock and executable identities, unchanged across the final boundary:**

   | identity | SHA-256 |
   | --- | --- |
   | committed `package-lock.json` | `f08d38d0938c29b0c8302b25d2235e7d6629f108d6c415bcabeb3481d1a33663` |
   | Node 22.18.0 executable | `9187ad22c98cea5b635a79db52fa32ab3f6aa9d41e3abf5da71437cfef1ca9de` |
   | Vitest entry | `39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6` |
   | Vitest manifest | `6ea35e567829660d9832744086c18526b9ddebd5358c4a0cadfb0a355925f917` |
   | vite-node entry | `187a031df1b2c5b9e2251d08c3ec51d0f8c790296da47eb7da8d4ab605c1a500` |
   | vite-node manifest | `7018dacaa212db8e05f454147ac95b817c96b5e45fe56379f8ed54e11617b138` |
   | TypeScript entry | `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675` |
   | TypeScript manifest | `822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6` |

4. **Mutable caches:** all focused Vitest runs used `--no-cache`. The shared `node_modules/.vite/vitest/results.json` remained 143 bytes with SHA-256 `819161f10f19a88ee3395607d3564b13fa7de86a0765f4fcc83d4d0b2a88926d` and mtime `1787087187236.3757` ms, identical to the R2 boundary record.

## Commit-gate evidence

The first published R4 commit exposed a worktree-construction defect rather than a product-test
failure: the worktree did not contain Husky's generated hook shim, so its commit never invoked the
local `instar-dev` gate. The pull-request decision-audit check correctly refused that commit. I ran
the repository's `npm run prepare` wiring step, supplied the plain-language and side-effects
artifacts required by the gate, and reconstructed the complete R4 patch from its publication base
so the live pre-commit hook evaluated the two source files themselves. I did not write, edit, copy,
or pre-shape a decision-audit record.

The successful hook run generated its own per-entry record. That generated record, the two scoped
source files, and the supporting gate artifacts are members of the same replacement commit. A
post-commit read verified that the record's scoped-file list names exactly
`src/providers/adapters/openai-codex/_smoketest.ts` and
`src/providers/adapters/openai-codex/smoketest-result.ts`. The CI presence checker was also executed
locally against the actual `db09c05e...` base-to-replacement-head range. It accepted the generated
record in that range.

This is stronger than the CI check alone. The check requires at least one decision-audit record in
the pull-request diff whenever any in-scope path differs; it does not correlate a record's internal
scope to each changed source file. Same-commit membership and exact scoped-file identity were
therefore verified separately rather than inferred from a green presence check.

## Scope and disposition

- Branch: `phaseb/r4-structured-codex-smoke`.
- Construction base: R2 commit `07011763580d2b76df5290e39b684f43f46ab8c1`.
- Actual publication merge base: `00f0111fd19050528dc708196c3451cae4ec8935`.
- Canonical main fetched immediately before publication:
  `db09c05e0a63b3e70f08ae5905a4be5b67b0f870`.
- The one intervening main commit adds `REPORT-H3.md` and changes
  `authenticated-execution-receipt.test.mjs`; neither path overlaps R4's five-file diff. Per the
  operator's instruction, R4 remains based on `00f0111fd...` and shared CI will test its merge with
  current main. A read-only merge simulation against fetched `upstream/main` completed without a
  conflict and produced tree `809fe399f01f58aab4c34ab4b519a0a2f5c6152e`.
- `.github/**` untouched.
- No checker weakening, threshold change, exemption, or exclusion.
- No dependency install, approver key, merge, or live provider call. Replacing the already-published
  ungated commit required one lease-guarded history update after the live gate created the audited
  commit.
- Push and pull-request publication were authorized after the initial hold; this report does not
  claim or authorize a merge.

Disposition: **ready for independent review as a low-severity consistency closure.**
