# W3.7 — authenticated structured observation

## Status

**BUILT WITH HAND EVIDENCE; independent b03 judgement pending.** This report does not grade the repair. No merge was performed.

```text
branch: phaseb/w37-authenticated-structured-observation
base:   6f4d6599ea7c601f917c8db5cd1b6b3c1a3266b9 (phaseb/w36-structured-test-counts)
brief:  scratchpad/phaseB/lane-W37-brief.md
brief sha256: 4b84ff2fe89ade27cb683268ffed804a4748aa93d27b9518a1ca187c7a6820e0
pull request: pending at report authoring; appended after publication
```

## What changed

The structured event collector is no longer executed from the candidate checkout merely because it has a digest-shaped identity.

1. A protected schema-v3 execution plan must carry the exact expected SHA-256 of `scripts/lib/standards-enforcement-node-test-runner.mjs`.
2. The verifier reads those runner bytes from the protected snapshot, compares them with that protected expected digest, and returns UNKNOWN with no artifact on mismatch.
3. The compared protected bytes are materialized into each isolated clean, mutated, and pristine-confirmation workspace. The runner is checked again immediately before each execution as a regular non-symlink file with the exact expected digest.
4. Each materialized runner creates an ephemeral Ed25519 identity and signs a ready event followed by the exact structured observation event. H1 pins the ready identity, authenticates the sequenced observation, and issues the child-exit receipt only when its observer session, event sequence, event kind, and event-signature hash match the last authenticated event.
5. A promotable artifact retains the authenticated event, its recomputed observation digest, and the receipt linkage. Live-artifact validation rechecks every link.

The independently protected expected runner digest is:

```text
04795f8857d8bb08ccf7c0a18103b7233ef644b395ac9bd576d9726e98da57f2
```

The H1 receipt core was not modified. Its SHA-256 remained:

```text
6534ed0983b733311d343c23b60bc70d13648ca9d911a136875504d20d6e4817
```

## Can `node --test --test-reporter=json` remove the collector?

**No on both exercised supported runtimes.** `json` is not a built-in Node test reporter in Node 22.18.0 or Node 25.6.1. Both commands treated `json` as a custom reporter package and exited 7 with `ERR_MODULE_NOT_FOUND: Cannot find package 'json'`.

```text
Node 25.6.1: node --test --test-reporter=json <probe> -> exit 7, ERR_MODULE_NOT_FOUND
Node 22.18.0: node --test --test-reporter=json <probe> -> exit 7, ERR_MODULE_NOT_FOUND
```

Supplying a local custom JSON reporter would merely move the authorship fault into another branch-owned collector. Node's programmatic `node:test.run()` `TestsStream` remains the native structured source, so W3.7 keeps the small collector but makes its exact protected bytes authoritative and receipt-binds its output.

## Rider: shared `node_modules` route

**Route A was used. No install or rebuild was run.** The W3.7 `node_modules` symlink resolves to:

```text
/Users/justin/.instar/agents/instar-codey/.worktrees/phaseb-w35-observed-enforcement-proof/node_modules
```

The production evidence collector does not resolve through that tree: it is read from the protected repository snapshot and copied into a fresh isolated workspace. The structured reporter is Node core. The outer Vitest test harness and its transitive dependencies do resolve through the shared tree.

Named entrypoint pins:

| Element | Resolved path / identity | SHA-256 |
|---|---|---|
| Node 25 runner + built-in `node:test` | `/opt/homebrew/Cellar/node/25.6.1/bin/node` | `f739e02b8e68d8accc60f15308c0d1dbe9cde2dfdb15463ba7389103b1b450e1` |
| Node 22 runner + built-in `node:test` | `/Users/justin/.asdf/installs/nodejs/22.18.0/bin/node` | `9187ad22c98cea5b635a79db52fa32ab3f6aa9d41e3abf5da71437cfef1ca9de` |
| protected collector/runner | protected `scripts/lib/standards-enforcement-node-test-runner.mjs`, then isolated copy | `04795f8857d8bb08ccf7c0a18103b7233ef644b395ac9bd576d9726e98da57f2` |
| Vitest entry | shared `node_modules/vitest/vitest.mjs` | `39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6` |
| Vitest CLI | shared `node_modules/vitest/dist/cli.js` | `88e96cc0817e9248dadf452c0db5f543dc25ec9ce1c801c2310ca3ac8ffdf48d` |
| Vite CJS entry | shared `node_modules/vite/index.cjs` | `9f3d9f0d380bb14380fe3cd9c64be336ae0b892613229b07d837ab44784cbb96` |
| Vite Node entry | shared `node_modules/vite/dist/node/index.js` | `2b295e9da790eb9d1b02b167a4678bd9106253d97e07a75f774cd2f3b1930476` |
| TypeScript verifier | shared `node_modules/typescript/lib/typescript.js` | `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675` |
| YAML config dependency | shared `node_modules/js-yaml/index.js` | `7d1ebc0d9929b9124997b439d1a1fd9aff8feb6bb0a1b59e977ea638944f34ba` |

To cover transitive harness inputs rather than only named entrypoints, the final run hashed the resolved shared tree deterministically as sorted entry type + relative path + file SHA-256 (or symlink target). With Vitest cache disabled, the preflight and postflight values were identical:

```text
shared input tree sha256: 0a73b6e90809f117f3134e94061f27aaa2133cf1b2c8dbee4d9e15508f93f6de
regular files: 13,966
symlinks: 30
regular-file bytes: 572,000,653
excluded runtime output: .vite/vitest/results.json
```

The exclusion is not silent. An earlier full-tree run correctly failed its postflight because Vitest changed only `.vite/vitest/results.json` from 123 to 129 bytes. That file is a runtime result cache, not collector/reporter/runner input. The deciding run used `--no-cache`; its mtime remained at 12:22:04 PDT while the run started at 12:24:13 PDT, and every other byte in the resolved tree matched before and after. A later attempt to include that disabled output in an all-byte pin correctly refused at preflight because a concurrent lane had changed it again (129 to 125 bytes); no tests ran. That confirms why the evidence manifest excludes exactly this non-input runtime output while pinning every transitive input. Nothing in the shared tree was installed, rebuilt, restored, or otherwise rewritten by hand.

## Decisive observed controls

Final Node 25.6.1 run, with full shared-input-tree preflight/postflight and `--no-cache`:

```text
W37_ROUTE_A_FINAL_PREFLIGHT ... sharedInputTreeSha256=0a73... files=13966 links=30 bytes=572000653
W37_C2 expectedRunnerSha256=04795... actualRunnerSha256=c2e947... runnerExecuted=false outcome=UNKNOWN artifact=null
W36_C1 source="node:test TestsStream" misleadingRendererCounts=ignored mutationLanded=true cleanExit=0 cleanTests=1 mutatedExit=1 mutatedTests=1 confirmationExit=0 confirmationTests=1 failureKind=assertion artifact=authenticated verdict=ratchet
W37_C1 protectedRunnerSha256=04795... digestCompared=true protectedRunnerMaterialized=true observationsReceiptBound=true verdict=ratchet
Test Files  1 passed (1)
Tests       16 passed (16)
W37_ROUTE_A_FINAL_POSTFLIGHT ... sharedInputTreeSha256=0a73... files=13966 links=30 bytes=572000653
```

The C2 forged runner contains an exact-schema summary claiming 999 passing tests and writes a per-test absolute marker supplied through a stable environment variable. Its protected bytes hash to `c2e947b7cecad6cd60afa3f77399a781258a8e0b5f2d54f8a6ec5e3e742b52b0`, not the protected expected digest. The verifier refused before execution; the marker did not exist, the result was UNKNOWN, and the artifact was null.

The accepted two-way discrimination remained intact:

- C1 genuine observer: clean pass, mutated assertion failure, pristine confirmation pass -> ratchet.
- C3a vacuous `expect(true)`: mutation survives -> NOT-PROVEN.
- C3b mutation-insensitive subject import: mutation survives -> NOT-PROVEN.
- C3c stateful hollow observer: confirmation does not reset -> NOT-PROVEN.
- C3d inherited-pipe descendant: bounded timeout -> UNKNOWN.
- Both forged renderer summaries (`# tests 999` and `ℹ tests 999`) remain present and ignored.

Node 22.18.0 independently ran all 16 measurement tests with the same C1/C2/C3 outcomes before the marker-path tightening. After that test-only tightening, Node 22 reran the decisive C1 and C2 controls: 2 passed, 14 skipped. Its Node binary and complete shared input-tree digests matched before and after.

The affected coverage path also remained green:

```text
Test Files  1 passed (1)
Tests       4 passed | 34 skipped (38)
Duration    100.66s
shared entrypoint preflight: match
shared entrypoint postflight: match
```

## Mutation identity and relevance

C1 mutates the independently declared subject imported by the observer, not the observer or collector:

```text
subject: src/certified-subject.mjs
before: export const guarded = true;
before sha256: c6b3e0ed964e1a5590db6e19bfe7a1811e0f0a285455868c5250c49551890001
after:  export const guarded = false;
after sha256: f2f4e1d6a3c6521262e7b8fa84d2ead164e0d2594f0f47d2801c619ebe68539c
```

The hashes are distinct, the observer imports `guarded`, the mutated run fails with structured `ERR_ASSERTION`, and the independently materialized pristine confirmation passes.

## Failure classification during construction

- Worktree creation first stopped after creating the worktree because the setup hook could not find `husky`; the sanctioned setup was completed without an install. Setup failure, before assertions.
- A sandboxed Vitest invocation could not create its temporary config in the sanctioned worktree. Permission/setup failure, before assertions; the identical permitted run was then used.
- The first positive W3.7 assertion run failed because the old guard ID contained NUL separators and could not be transported as child argv. This was a real implementation defect, not environmental; the guard ID is now the SHA-256 of the canonical protected identity tuple.
- The first full shared-tree postflight detected Vitest's six-byte `results.json` cache change. This was treated as real shared-state drift. Cache was disabled and the complete remaining input tree was pinned; no shared install or manual repair was performed.
- A later all-byte preflight refused before tests because a concurrent lane changed that same disabled results cache. This was a successful pre-execution refusal, not retried as evidence; the cache-disabled input manifest remained the deciding Route A proof.
- Final source audit found that the first C2 marker path was relative to the disposable isolated workspace, so it did not independently prove non-execution. The control now uses a per-test absolute marker through a stable environment variable; the corrected C2 passed on Node 25 and Node 22.
- The longer coverage command was twice cut off by tool transport before a result; neither partial run was counted. A persistent terminal run completed once and supplied the recorded evidence.
- The first Node 22 aggregate wrapper had a JavaScript syntax error and exited before preflight or tests. The wrapper was corrected once; the resulting C1/C2 run passed with matching pre/post digests.

No assertion mismatch was retried unchanged until green.

## Changed-file identities

| File | Before SHA-256 | After SHA-256 |
|---|---|---|
| `scripts/lib/standards-enforcement-node-test-runner.mjs` | `0b67bd259c7cd078ab4feba10a814e9c6007a210c40b98a2382042b2feb36cc1` | `04795f8857d8bb08ccf7c0a18103b7233ef644b395ac9bd576d9726e98da57f2` |
| `scripts/lib/standards-enforcement-execution-verifier.mjs` | `bb3662dcc3c31d9aff6aa0074388294f9d54f0d05249d19c693366f511f492d5` | `0cf6fbb303a49c664bd1587bdf852e58fde02b85408167b984bb07e9c7fadde4` |
| `scripts/lib/standards-enforcement-measurement.mjs` | `ebdd8047399c41560c6214ed4f62269264585466acec22830b676d696b8e5646` | `0c34eeb22e49602c7fba2315a1de75a160cf3bb82628d7654f4bd2a8b97332f0` |
| `tests/unit/standards-enforcement-measurement.test.ts` | `9f1470269337bacb29ede637c1bf0ee687d96ff60b0ac8c7def6f368e32238dc` | `7345c2c879c991d34101238b17c5e6c3833efa75809d64e41824d8fb31d14bb2` |
| `tests/unit/standards-coverage-ratchet.test.ts` | `4a1e0efe7c08efa50f9d2a6b7c88c18f04b85fbb199f3829562aba9a8de7e33c` | `a9f60fca2d219efac9ae7585fab0096cb547aa2ca426f06833d0ee4cf88b4e60` |

The new report, upgrade notes, and decision record have no pre-change bytes.

## Other verification

```text
Node: v25.6.1 (primary), v22.18.0 (compatibility)
node --check (three changed .mjs files): exit 0
tsc --noEmit: exit 0; Node and TypeScript digests matched pre/post
git diff --check: exit 0
```

No approver key was created. No CI file was changed. No force-push or merge was performed.
