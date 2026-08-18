# P3B — fresh current-instrument property battery for the reconciled checker guard

## PRE-C1 TARGET DECLARATION — 2026-08-18 12:28:53 -0700 (PDT)

This target was declared in the durable run record before any C1 pristine control or property invocation:

```text
target branch: phaseb/f2-certified-summary-reconciliation
target commit: 859e90347555fec34ae5d9500752b058658ca507
target role: J16-certified structured-output implementation ported onto the measured F1 line
runner: Instar-codey, lane P3B
C1 status at declaration: NOT RUN
property battery status at declaration: NOT RUN
```

This run is runner-authored evidence, not an implementation change or independent judgement. Every result is provisional pending independent judgement of both the port and this battery. If the port is refused, this battery is void. The original `REPORT-P3.md` remains the authoritative stopped result for target `3801aefe9825e1258f5f235c123c56bee9e6a98b` and will not be overwritten.

## PRE-C1 MEASUREMENT BOUNDARY — 2026-08-18 12:36:38 -0700 (PDT)

No C1 or property process had run when this section was written. The clean detached measurement checkout was created from the declared commit, not from working-tree bytes:

```text
measurement checkout: /private/tmp/instar-p3b-859e903-0ArROb/target
HEAD: 859e90347555fec34ae5d9500752b058658ca507
porcelain: []
Node: v22.18.0
live protected authority: https://github.com/JKHeadley/instar.git refs/heads/main
live server resolution: 248ed7177f5bf416aa7bdad9763741478195e1fc
```

Pinned outer instrument identity:

```text
instrument worktree: phaseb-w4-r-regular-file-identity
instrument commit: fee69a8eefe406ccf9062ac8fd4b41f58e084680
instrument SHA-256: c9fab8034effc8f64c525073f85c7c04c1fd5cca9c0b2324203632ea34145b3a
instrument-test SHA-256: c38827b6ab50c245244e4ded34e20c1c421651a08f29b02bd37db499c26653fe
receipt-authority SHA-256: 6534ed0983b733311d343c23b60bc70d13648ca9d911a136875504d20d6e4817
manifest SHA-256: a3ae19ae23bae375f48de04d51aa9f17e674e20783bdfd0d9dd5b5815b864677
checker adapter SHA-256: e3f66283ba3d265d0ebdc7fe56198200a45cbabbcc62369156c0c4d660c7fa77
```

### J20 dependency and cache record — BEFORE

```text
outer instrument dependency argument: .../phaseb-w4-r-regular-file-identity/node_modules
outer instrument dependency root after realpath: /Users/justin/.instar/agents/instar-codey/.worktrees/phaseb-h1-authenticated-execution-receipts/node_modules

provided measurement dependency argument: /private/tmp/instar-p3b-859e903-0ArROb/node_modules-overlay
provided measurement dependency root after realpath: /private/tmp/instar-p3b-859e903-0ArROb/node_modules-overlay
resolved immutable package source: /Users/justin/.instar/agents/instar-codey/.worktrees/phaseb-f1-blind-checker-ratchet/node_modules

committed instrument lockfile SHA-256: f08d38d0938c29b0c8302b25d2235e7d6629f108d6c415bcabeb3481d1a33663
committed target lockfile SHA-256: f08d38d0938c29b0c8302b25d2235e7d6629f108d6c415bcabeb3481d1a33663
outer installed .package-lock.json SHA-256: bd72886c1ba769e9c0b61a883f823ec9d9eac4b158761a39d5d0ef09b26f5133
measurement installed .package-lock.json SHA-256: 86d75a245c2581a8b379587df320b1f62313f550314930d8312aef35ecbd14ff

js-yaml approved version: 4.1.1
js-yaml approved integrity: sha512-qQKT4zQxXl8lLwBtHMWwaTcGfFOZviOJet3Oy/xmGk2gZH677CJM9EvtfdSkgWcATZhj/55JZ0rmy3myCT5lsA==
outer js-yaml entry SHA-256: 7d1ebc0d9929b9124997b439d1a1fd9aff8feb6bb0a1b59e977ea638944f34ba
measurement js-yaml entry SHA-256: 7d1ebc0d9929b9124997b439d1a1fd9aff8feb6bb0a1b59e977ea638944f34ba
outer js-yaml package aggregate (32 regular files): 234377c610468a2365beb72e5eed934e8690e04c772630ea877153c02fec480b
measurement js-yaml package aggregate (32 regular files): 234377c610468a2365beb72e5eed934e8690e04c772630ea877153c02fec480b

Vitest approved version: 2.1.9
Vitest approved integrity: sha512-MSmPM9REYqDGBI8439mA4mWhV5sKmDlBKWIYbA3lRb2PTHACE0mgKwA8yQ2xq9vxDTuk4iPrECBAEW2aoFXY0Q==
outer Vitest entry SHA-256: 39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6
measurement Vitest entry SHA-256: 39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6
outer Vitest package aggregate (116 regular files): a52603846c3f92f20446063cdc34f313e1c8d8ececdb0142408d64d3dd69635d
measurement Vitest package aggregate (116 regular files): a52603846c3f92f20446063cdc34f313e1c8d8ececdb0142408d64d3dd69635d
```

Each package aggregate is SHA-256 over a lexically ordered list of `SHA256(file-bytes) + two spaces + package-relative-path + newline` for every regular file below the real package root. The same algorithm will be repeated after the measurement.

Mutable-cache disposition: **isolated, not reused**. The provided measurement root is a per-proof overlay outside every shared dependency tree. Its package entries are symlinks to the resolved immutable source above, while `.vite/` is a new real directory at `/private/tmp/instar-p3b-859e903-0ArROb/node_modules-overlay/.vite`. `vitest/results.json` was absent before C1. Thus the run shares approved package bytes but neither reads nor writes the F1 tree's mutable Vitest cache. No reinstall occurred.

### Pristine tracked-byte stamps — BEFORE

```text
409fbf5866541ea6899e15e562680d47476ab63f0b409bc96c26fa3a4ee67984  scripts/lint-llm-attribution.js
e96cfa613a4b97a4334007546867f64bcae73169e9565450ab42d35e2d9c46ff  scripts/checker-blind-input-cases.mjs
dfebb009ea3784eb1a006519461377d2820645701a029959cbacbdbfc357e4af  scripts/lint-checker-blind-input-coverage.mjs
98907ead3be3171c946e343cad9b859475a27997b84670718362e7cfba8bc312  scripts/lib/checker-blind-input-ratchet.mjs
d0018f709d12ea0e8e974cacd142cefc95cdbe203a83bf62962854119f78add6  tests/unit/checker-blind-input-ratchet.test.ts
```

C1 status at this boundary: **NOT RUN**. The admissibility rule is fixed in advance: one pristine attempt; any nonzero assertion mismatch voids the battery and is never relabeled environmental; no retry-until-green; no property credit for anything not actually measured.

## C1 — PASS on the single pristine attempt

The direct production command was run once at the declared detached target:

```text
node scripts/lint-checker-blind-input-coverage.mjs
C1 exit: 0
Test Files  1 passed (1)
Tests  18 passed (18)
checker-blind-input: population=96 execution-proven=5 legacy-uncovered=91/91 new-checkers=1 protected-base=248ed7177f5b
checker-blind-input: executable blind cases passed
```

The repaired type-preserving control executed two real Node reporters. Both child processes exited 1 and yielded the same structured record: tests 1–3 failed with `ERR_ASSERTION`, while the named genuine control test 4 passed.

```text
P3_3d_TYPE_PRESERVING_HOLLOW mutationApplied=true tapChildExit=1 specChildExit=1
F4_DECORATION_CONTROL renderer=tap structuredVerdict=reject ...
F4_DECORATION_CONTROL renderer=spec structuredVerdict=reject ...
```

This is a structured-event decision under genuinely different renderers, not a rendered-summary spelling check. Delete, comment-out, and superstring controls also each reported `mutationApplied=true` with a nonzero direct child.

At 12:39:46 PDT immediately after C1, porcelain remained empty and all five tracked stamps were byte-identical to BEFORE. The isolated cache was newly created only inside the per-proof overlay:

```text
isolated cache SHA-256 after C1: efffb293f464d6b376c0e769a5ed94437cef603f488a61d2405a83f218880191
isolated cache size: 123 bytes
isolated cache mtime: 2026-08-18 12:39:26 -0700
shared F1 cache touched by this run: NO
```

C1 is admissible. It was not retried. The full property verifier may now run once against the same target, protected authority, and provided dependency root.

## Full current-instrument record

The pinned verifier completed at `2026-08-18T19:51:11.722Z` with process exit `0`:

```text
measurement scope: full-property-and-wiring
declared target: 859e90347555fec34ae5d9500752b058658ca507
resolved target: 859e90347555fec34ae5d9500752b058658ca507
target dirty at start: false
target porcelain at start: []
provided dependency root: /private/tmp/instar-p3b-859e903-0ArROb/node_modules-overlay
record rung: effective
```

The verifier's own isolated C1 also passed once (`exitCode=0`, `timedOut=false`). This is the in-record positive control that the full verifier necessarily performs after the direct preflight gate above; neither control followed a failed guard assertion and neither was retried until green.

Two setup failures preceded the successful full record and receive no evidentiary credit. First, an output path outside the subprocess sandbox was refused with `EPERM`; the requested directory did not exist and no usable record was emitted. After redirecting output to the isolated run root, the sandboxed process emitted a fatal record because DNS access to the pinned GitHub authority was denied before protected-base acquisition. It contained zero mutations and P1–P5 all `unknown`. The identical verifier invocation was then allowed network access because the failure was explicitly environmental (`Could not resolve host`), not an assertion mismatch. The successful record below is the only property measurement.

### Wiring and controls

The protected authority resolved and fetched one base for the whole record:

```text
remote: https://github.com/JKHeadley/instar.git
ref: refs/heads/main
server/fetched commit: 248ed7177f5bf416aa7bdad9763741478195e1fc
workflow: .github/workflows/ci.yml
workflow SHA-256: be9f8f5393854f15793424613fa46da4701b4808219cb173a0d9da1aa649ef71
merge base: 248ed7177f5bf416aa7bdad9763741478195e1fc
```

The real workflow command `npm run lint` exited `0`. Its authenticated observer bound the exact regular-file entry `scripts/lint-checker-blind-input-coverage.mjs` to child PID `10887`, child exit `0`, and one post-child HMAC receipt. C3 then ran the same wrapper with the guard short-circuited: the wrapper still exited `0`, the signed short-circuit event authenticated, and the guard receipt count was exactly zero.

```text
C1: proven
C2: proven for every mutation
C3: proven
WIRING: proven
isolated copies: 11
target porcelain unchanged: true
```

### P1–P5 mutation audit

There were nine declared mutations. For every row, the raw record has `rootIsIsolated=true`, `applyError=null`, `mutationApplied=true`, `mutationRelevant=true`, relevance status `proven`, direct guard exit `1`, `timedOut=false`, `spawnError=null`, and `signal=null`.

| Property | Mutation | Applied/relevant result | Deciding guard observation |
|---|---|---|---|
| P1 | `p1-symbol-preserving-checker-hollow` | proven / proven | The preserved `runLint` API fabricated `blind: []`; the executable blind-case assertion named `blind-input-accepted`, outer test result was `1 failed / 17 passed`, and the guard returned NOT-PROVEN. |
| P2 | `p2-subject-self-reports-clean` | proven / proven | The subject added false `all-inputs-readable` testimony while returning an empty blind set; the external execution check still named `blind-input-accepted`, with `1 failed / 17 passed`. |
| P3 | `p3a-delete` | proven / proven | The real guard module was absent; direct child exit `1` with `ERR_MODULE_NOT_FOUND`. |
| P3 | `p3b-comment-out` | proven / proven | Every executable line was inert; direct child exit `1` because required exports were absent. |
| P3 | `p3c-superstring-rename` | proven / proven | The standalone evaluator symbol was absent; the suite executed and failed `4 / 18`. |
| P3 | `p3d-type-preserving-hollow` | proven / proven | The exact export/signature remained but returned constant `passed:true`; behavioral assertions executed and failed `2 / 18`, naming the false `within-ratchet` results. |
| P4 | `p4a-empty-population` | proven / proven | The production enumerator was forced to `[]`; the suite executed and failed `4 / 18`, including the non-empty population and missing-source controls. |
| P4 | `p4b-planted-nested-checker` | proven / proven | A real nested checker outside the declared file set had no case ID; recursive enumeration found it and the ceiling assertion failed `1 / 18`. |
| P5 | `p5-blind-production-checker` | proven / proven | The real production subject was mode `000`; the guard failed closed with `UNKNOWN ... EACCES`, exit `1`. |

The adapter's P3d mutation is distinct from the repaired target's own P3d control. The adapter tests whether the production guard survives a type-preserving hollow; the target-owned control is what independently distinguishes the exact four named Node test results under two real renderers. Both directions bit in this run.

No timeout, changing failure set, retry, or unobserved child contributes to any property. The effective set emitted by the instrument is exactly:

```text
P1: proven
P2: proven
P3: proven (delete, comment-out, superstring rename, type-preserving hollow)
P4: proven (empty population, nested population evasion)
P5: proven
EFFECTIVE AGAINST {blind input / fail-open, guard removal, hollowing, population evasion, self-report / false testimony, vacuous measurement}
```

## J20 dependency and cache record — AFTER

At `2026-08-18 12:52:43 -0700 (PDT)`, the identical digest procedure produced:

```text
outer instrument dependency root after realpath: /Users/justin/.instar/agents/instar-codey/.worktrees/phaseb-h1-authenticated-execution-receipts/node_modules
provided measurement dependency root after realpath: /private/tmp/instar-p3b-859e903-0ArROb/node_modules-overlay

committed instrument lockfile SHA-256: f08d38d0938c29b0c8302b25d2235e7d6629f108d6c415bcabeb3481d1a33663  (unchanged)
committed target lockfile SHA-256: f08d38d0938c29b0c8302b25d2235e7d6629f108d6c415bcabeb3481d1a33663  (unchanged)
outer installed .package-lock.json SHA-256: bd72886c1ba769e9c0b61a883f823ec9d9eac4b158761a39d5d0ef09b26f5133  (unchanged)
measurement installed .package-lock.json SHA-256: 86d75a245c2581a8b379587df320b1f62313f550314930d8312aef35ecbd14ff  (unchanged)

outer js-yaml entry SHA-256: 7d1ebc0d9929b9124997b439d1a1fd9aff8feb6bb0a1b59e977ea638944f34ba  (unchanged)
measurement js-yaml entry SHA-256: 7d1ebc0d9929b9124997b439d1a1fd9aff8feb6bb0a1b59e977ea638944f34ba  (unchanged)
outer js-yaml package aggregate: 234377c610468a2365beb72e5eed934e8690e04c772630ea877153c02fec480b  (unchanged)
measurement js-yaml package aggregate: 234377c610468a2365beb72e5eed934e8690e04c772630ea877153c02fec480b  (unchanged)

outer Vitest entry SHA-256: 39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6  (unchanged)
measurement Vitest entry SHA-256: 39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6  (unchanged)
outer Vitest package aggregate: a52603846c3f92f20446063cdc34f313e1c8d8ececdb0142408d64d3dd69635d  (unchanged)
measurement Vitest package aggregate: a52603846c3f92f20446063cdc34f313e1c8d8ececdb0142408d64d3dd69635d  (unchanged)
```

The target checkout remained porcelain-clean, and all five guard/subject stamps listed in BEFORE were unchanged. The per-proof cache changed as expected from scheduling metadata only:

```text
cache before C1: absent
cache after direct C1: efffb293f464d6b376c0e769a5ed94437cef603f488a61d2405a83f218880191 (123 bytes)
cache after full record: eb5d877ab29308e2c1cb49b41c26d8191d21995c7719653d20904c5b16f45fba (122 bytes)
final cache mtime: 2026-08-18 12:51:04 -0700
cache location: /private/tmp/instar-p3b-859e903-0ArROb/node_modules-overlay/.vite/vitest/results.json
disposition: isolated; never reused from or written into a shared dependency tree
```

Thus executable parser/runner bytes and both committed lock identities were stable across the run, while the one mutable dependency-side input was confined to a fresh directory outside the shared tree. No install occurred.

## Evidence and provisional ruling

```text
2b3e1335b18db572c3d84786a7376aca39a4856828a5a5409f4026cee0764b3d  scratchpad/phaseB/evidence/P3B-checker-blind-input-coverage.json
raw record size: 276860 bytes
runner: Instar-codey, lane P3B
target: 859e90347555fec34ae5d9500752b058658ca507
instrument: fee69a8eefe406ccf9062ac8fd4b41f58e084680 / c9fab8034effc8f64c525073f85c7c04c1fd5cca9c0b2324203632ea34145b3a
```

**PROVISIONAL RUNNER RESULT:** `EFFECTIVE AGAINST {blind input / fail-open, guard removal, hollowing, population evasion, self-report / false testimony, vacuous measurement}` for exact target `859e90347555fec34ae5d9500752b058658ca507`.

This is not independent judgement and grants no final credit by itself. Both the F2 port and this P3B battery still require independent review; if the port is refused, this entire battery is void. The original `REPORT-P3.md` and its stopped result for `3801aefe9825e1258f5f235c123c56bee9e6a98b` remain unchanged.
