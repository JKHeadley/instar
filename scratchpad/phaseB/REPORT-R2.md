# REPORT R2 — exact population assertions for phase acceptance

## Result and severity

**Built; independent judgment pending. Severity: LATENT, not exploitable.**

The Phase 4 parity gates combined an exit-code expectation with a presentation-text substring. The parity runner exits non-zero when a scenario fails, so the exit-code check currently masks the substring defect. No demonstrated failing parity run can pass the complete present-day gate.

The substring assertion still failed its own purpose. Exit code answers “did anything fail?”; the output contract must independently answer “did the expected population run?” A zero-scenario exit-0 runner is invisible to the first question, while `stdout.includes('0 fail')` cannot reliably answer the second.

## Premise checked before build

The supplied brief matched SHA-256 `fbefb5cec4291612d90d5804505b31c033fd6873fd8a2e83bdb60928692a9f92`.

Before modifying source, I executed the exact `upstream/main` checker source in a controlled VM seam. Its manifest expected exit 0 plus `expectStdoutContains: "0 fail"`; its runner returned exit 0 and complete stdout `10 fail`. The legacy checker marked the gate PASS and itself exited 0:

```text
R2_PRE_FIX_CONTROL runnerExit=0 stdout="10 fail" legacyGate=PASS checkerExit=0
```

This confirms the dispatch premise. It is a negative control for the substring assertion, not evidence of a live release bypass: a real parity failure still produces a non-zero exit today.

## Repair

### Structured producer

`runParitySuite` already returned a typed `ReadonlyArray<ParityResult>`, as the brief suggested. R2 verified that directly and added a summary derived from those results:

```json
{
  "schema": "instar-parity-summary/v1",
  "total": 7,
  "passed": 5,
  "failed": 0,
  "skipped": 2
}
```

`_codex_paritytest.ts --json` emits one such document. Without `--json`, the existing human-readable report remains unchanged.

### Structured consumer

The phase checker now supports `expectJson` with:

- a selected stream (`stdout` or `stderr`);
- a required schema identifier; and
- exact typed equality for declared fields.

The selected stream must be exactly one JSON document. A substring, partial token, wrong schema, missing declared field, or string-valued declared count cannot satisfy the contract. Undeclared additional properties are allowed for forward-compatible enrichment within a schema version; the acceptance policy is exact over the fields the manifest declares.

Phase 4 now asserts:

| gate | exact expected population |
|---|---|
| structural parity | total 7, passed 5, failed 0, skipped 2 |
| real-API parity | total 7, passed 7, failed 0, skipped 0 |

The structural split is intentional: all seven scenario records must be accounted for, while the two real-API scenarios are explicitly skipped when real API is disabled. The real-API gate accepts no skips.

### Three distinct outcomes

| observed outcome | exit code | structured observation | R2 result |
|---|---:|---|---|
| ran and all passed | 0 | exact seven-result all-pass contract | PASS |
| ran and some failed | deliberately forced to 0 in C2 | `failed: 1` / `passed: 6` | FAIL from JSON field comparison |
| did not run | deliberately forced to 0 in C3 | total/pass/fail/skip all zero | FAIL from total comparison |

C2 deliberately lies with exit 0, so its rejection proves the population assertion is load-bearing rather than leaning on the coincidence that masks the legacy defect.

## Controls — each runner observed executing

Every fixture writes a per-run marker before it emits output. Each test asserts that marker exists and contains `executed` before examining the gate result.

```text
R2_C1 runnerExecuted=true runnerExit=0 stdout="10 fail" repairedGate=FAIL
R2_C2 runnerExecuted=true runnerExit=0 total=7 failed=1 repairedGate=FAIL
R2_C3 runnerExecuted=true runnerExit=0 total=0 failed=0 repairedGate=FAIL
R2_C4 runnerExecuted=true runnerExit=0 total=7 failed=0 repairedGate=PASS

Test Files  1 passed (1)
Tests       4 passed (4)
```

This is both-direction evidence: three must-fire cases and the genuine must-not-fire case.

## Real wiring

The real structural CLI produced:

```text
{"schema":"instar-parity-summary/v1","total":7,"passed":5,"failed":0,"skipped":2}
```

An unchanged-code structural checker run with worktree write access reported:

```text
[PASS] typescript-compile
[PASS] unit-tests-codex
[PASS] capability-honesty-canary
[PASS] parity-structural
Phase 4: CODE-COMPLETE — 4/4 structural, real-API skipped
```

Its final process exit was 1 by design because `--structural-only` does not claim real-API verification. The relevant fact is that the real manifest's JSON population gate executed and passed. A first sandboxed attempt had the two Vitest commands fail before tests because Vite could not create a transient config bundle beside `vitest.config.ts`; that environmental denial was classified, and the exact unchanged checker was executed once with worktree write access. It was not a retry-until-green test failure.

## Undeclared `tsx` finding

The prior manifest commanded `npx tsx`, but `tsx` is absent from the committed lockfile and from the installed dependency tree. Running it would ask `npx` to fetch an unpinned tool into npm's cache. R2 did not do that and added no package. The manifest now invokes the repository's lock-approved `vite-node` entry directly:

```text
node node_modules/vite-node/vite-node.mjs src/providers/parity/_codex_paritytest.ts --json
```

This is a smaller and more reproducible evidence path than adding a new dependency solely for an already-supported TypeScript entry.

## J20 dependency and cache record

No install or rebuild ran.

1. **Outer-instrument dependency root, symlinks resolved:**

   `/Users/justin/Documents/Projects/instar-codey/.worktrees/audit-j6-main-20260818/node_modules`
2. **Measurement dependency root, symlinks resolved:** the same directory. The focused Vitest controls, TypeScript verification, real parity CLI, and phase checker all resolve through the R2 worktree's ignored symlink to this root.
3. **Lock, entry, and package identities at the final pre-boundary:**

   | identity | SHA-256 |
   |---|---|
   | committed `package-lock.json` | `f08d38d0938c29b0c8302b25d2235e7d6629f108d6c415bcabeb3481d1a33663` |
   | Node 25.6.1 executable | `f739e02b8e68d8accc60f15308c0d1dbe9cde2dfdb15463ba7389103b1b450e1` |
   | Vitest entry `vitest.mjs` | `39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6` |
   | Vitest `package.json` | `6ea35e567829660d9832744086c18526b9ddebd5358c4a0cadfb0a355925f917` |
   | Vitest package aggregate (116 entries) | `d29b3a4ff7e39f50fddbc84c02735f9c7a9309a6fc88c385a4d49f0799791bf0` |
   | vite-node entry `vite-node.mjs` | `187a031df1b2c5b9e2251d08c3ec51d0f8c790296da47eb7da8d4ab605c1a500` |
   | vite-node `package.json` | `7018dacaa212db8e05f454147ac95b817c96b5e45fe56379f8ed54e11617b138` |
   | vite-node package aggregate (48 entries) | `b5c93e37504899eb7fcac6d59e72edf7f3a4ec37c1c8315c5a30f6b8bec5d9ae` |
   | TypeScript entry `typescript.js` | `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675` |
   | TypeScript `package.json` | `822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6` |
   | TypeScript package aggregate (132 entries) | `41c1cc58a87e37478542e892904e96c3aba73d8cd10f0a25232bdf79c71f0bc2` |

   Package aggregates hash sorted rows of entry type, package-relative path, and per-file digest (or symlink target), separated with NUL delimiters. Every listed lock, entry, manifest, and package aggregate had the same post-boundary digest.
4. **Mutable caches:** focused Vitest runs use `--no-cache`. The two Phase 4 manifest Vitest commands now also carry `--no-cache` explicitly. Before that manifest flag was added, a wired checker run demonstrated the J20 hazard by creating shared `node_modules/.vite/vitest/results.json`; it was not deleted or restored. The final pre-boundary recorded that scheduling cache as 143 bytes with SHA-256 `819161f10f19a88ee3395607d3564b13fa7de86a0765f4fcc83d4d0b2a88926d` and mtime `1787087187236.3757`. Post-boundary path, size, digest, and mtime were identical. The final proof therefore neither read nor rewrote that disabled, non-input scheduling state.

The package/entry and cache post-boundary comparison is recorded in the final verification section below.

## Instrument identity

Base: `248ed7177f5bf416aa7bdad9763741478195e1fc` (`upstream/main`, version `1.3.1180`).

| changed instrument file | before SHA-256 | after SHA-256 |
|---|---|---|
| `scripts/check-phase-complete.cjs` | `dfebbfced59ef6ea8bda3bcf786792c0b890590b4aeb4c0725f31b1b74186cb1` | `8711dfcd88fdf6cfe6007377ed61cb51dcdbf1bb491996f2379f083da7470fdd` |
| `scripts/lib/phase-acceptance-output.cjs` | absent | `4bbb16459a26fd574391cfe901831c4d5a97e6306ee930479172ffb92855168e` |
| `specs/provider-portability/acceptance/README.md` | `88b6ad04fd6aadd307d158c81fb82bc5fccaf652a1b65cdb400098cdeb4e0934` | `661b08ce3df0083c671e4f77e094cba6917e7a61a59c49b6d60972145da980d9` |
| `specs/provider-portability/acceptance/phase-4.json` | `6b74281ed4bcc22d87ffa54036f41171146e9fb6787bb916201ccdf01f9706b6` | `a4d9fc01cae1f7cf5ed184ee5e1b78851e2a5c513dde650b140922ae04f803e2` |
| `src/providers/parity/_codex_paritytest.ts` | `a6f590792cb1a351270edfa4a065c429e810bda8dda030ea49dd28ae659440bd` | `6f823fec0f0c631d32bab106e130f2f8360a2549a190dd5dca196468b7bfd433` |
| `src/providers/parity/index.ts` | `aed54f16ba18f1de79967d7d1062f63760ed97b25cac874280c423dc38fa9442` | `1645a616b39812a9f44e51f13a1db1185149adcc3e6cf93034ed9fb009521769` |
| `src/providers/parity/runner.ts` | `8383b5e16eed9e279ff52264782aff52adafc2ef1d55d101ecdb5d9d7ec94ce9` | `cbb6fdf0074a5990cf176dc1eb006378afefc9b13645023616e54a6441ace248` |
| `tests/unit/phase-acceptance-population.test.ts` | absent | `4a177b23cf4b7d6de9718c80285b9f5e07de5c8c899baedbba0e17de874c5404` |

## Final verification

Final finished-code controls, cache disabled:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
Duration    38.14s (tests 1000ms)
```

Final real manifest wiring:

```text
[PASS] typescript-compile (19241ms)
[PASS] unit-tests-codex (4390ms)
[PASS] capability-honesty-canary (1402ms)
[PASS] parity-structural (724ms)
Phase 4: CODE-COMPLETE — 4/4 structural, real-API skipped
```

Additional checks:

- `tsc --noEmit`: exit 0.
- `node --check scripts/check-phase-complete.cjs`: exit 0.
- `node --check scripts/lib/phase-acceptance-output.cjs`: exit 0.
- `git diff --check`: exit 0.
- Final lock, Node, Vitest, vite-node, TypeScript, all three package aggregates, and the disabled shared-cache record: exact pre/post match.

One earlier final-control invocation waited behind W3.8's live suite holder for the repository's full 120-second admission budget and exited 75 with explicit `no tests`. It is recorded as an admission failure, not a test result, and was not used as evidence. After the holder released normally, the finished-code proof above ran once and passed.

The second-pass reviewer initially found one documentation overclaim: the artifact called the JSON shape closed although extra enrichment properties are accepted. The artifact and report now state the actual boundary—exact schema plus exact declared fields—and the reviewer concurred.

## Scope and disposition

- `.github/**` untouched.
- No approver key used.
- No install or rebuild into the shared dependency tree.
- No force-push and no merge.
- The unrelated `codex-smoketest` `PASSED` sentinel remains a legacy text expectation; it does not assert a numeric population and is not the R2 count fault.
