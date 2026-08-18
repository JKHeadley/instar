# W3.8 — live-artifact integrity and prospective-authority closure

## Status

**BUILT WITH HAND EVIDENCE; independent judgment assigned to a different lane.** This report does not grade the repair. No merge was performed.

```text
branch: phaseb/w38-live-artifact-closure
base:   60642c7ea9986eda24027d31071487a6e93eca8d (phaseb/w37-authenticated-structured-observation)
implementation commit: pending first commit
pull request: pending
```

## What changed

### Limit 1 — reusable artifact integrity

The authenticated execution artifact schema advances from v3 to v4. Construction now recursively freezes the artifact and every reachable nested object/array before registering it as live. Clean and pristine-confirmation copies now carry the same assertion-classification fields as the mutated run.

`isLiveAuthenticatedExecutionArtifact()` now requires all of the following in addition to live WeakSet/event/receipt identity:

1. every reachable artifact object is frozen;
2. `artifactSha256` is recomputed from the canonical payload and matches exactly;
3. each clean, mutated, and confirmation signed observation remains schema-valid and digest-valid;
4. all five copied observation fields—`testsRun`, `passed`, `failed`, `assertionFailures`, and `decidingOutput`—exactly match the corresponding signed observation;
5. copied exit code and existing event/receipt kind, session, sequence, signature-hash, guard, PID, child PID, and argv links still match.

The W3.7 sentence that reusable validation “rechecks every link” is now true for the outer content address, copied observation values, signed event, and authenticated receipt chain.

### Limit 2 — prospective, not operating canonical authority

No runner or verdict ledger was added to main. Instead, every measurement record now carries `measurement.basis.executionAuthority`, with explicit `operational`, `prospective`, `test-stand-in`, or `unavailable` mode; the non-quiet CLI prints it.

“Operational” requires all of these facts at once:

- snapshot source is the content-addressed merge base derived from server-advertised canonical main;
- that snapshot contains `scripts/lib/standards-enforcement-node-test-runner.mjs`;
- that snapshot contains `docs/standards-enforcement-verdicts.json` in exact schema-v3 form;
- at least one structurally valid proof record binds the exact SHA-256 of the admitted runner bytes.

Explicit fixtures are labeled stand-ins even when they contain both files. Missing, empty, malformed, or digest-mismatched canonical state remains prospective and names the admissions still required.

## Observed controls

### Pre-fix red control

Before the repair, the newly added W38_C4 ran against W3.7 and failed for the intended reason:

```text
W38_C4 mutationBlocked=false originalTestsRun=1 currentTestsRun=999 predicate=true
AssertionError: expected false to be true
```

That run proved the exact scope limit: a caller could mutate a nested copied result and the exported live predicate still returned true.

### Post-fix two-way controls

The final targeted run observed both acceptance and refusal directions:

```text
W38_C4 mutationBlocked=true originalTestsRun=1 currentTestsRun=1 predicate=true
W38_C5 copiedObservationTampers=15 readdressed=true allRejected=true wrongContentAddressRejected=true
W38_C6 fixtureMode=test-stand-in canonicalNeither=prospective runnerOnly=prospective ledgerOnly=prospective emptyLedger=prospective mismatchedDigest=prospective canonicalBoundRecord=operational
Test Files  1 passed (1)
Tests       3 passed | 16 skipped (19)
```

- **Must accept:** the genuine recursively frozen artifact retains its original value and remains live.
- **Must fail:** all fifteen copied-field tampers (five fields across three runs) are rejected even after the clone is deep-frozen and its outer address recomputed; an independently wrong outer address is also rejected.
- **Must not overclaim:** fixtures, either missing canonical admission, an empty ledger, and a valid-shaped but mismatched digest all remain non-operational; only a canonical snapshot with runner bytes plus a fully valid digest-binding record reaches operational.

## Live canonical-main observation

At 2026-08-18 14:19 PDT, the production resolver read the server-advertised canonical main and returned:

```text
protected main: 248ed7177f5bf416aa7bdad9763741478195e1fc
merge base:     248ed7177f5bf416aa7bdad9763741478195e1fc
source:         canonical-server-content-addressed-merge-base
mode:           prospective
operationalOnCanonicalMain: false
runnerPresentInSnapshot: false
verdictLedgerPresentInSnapshot: false
runnerDigestBoundByVerdictLedger: false
```

The emitted statement was:

> Protected execution authority is NOT operational on canonical main; admit scripts/lib/standards-enforcement-node-test-runner.mjs and docs/standards-enforcement-verdicts.json with a schema-v3 record binding the admitted runner's exact SHA-256 before claiming protected digest authority.

This is a read and a record only. W3.8 does not make or imply the merge decision that would admit those files.

## Full verification

```text
Node 25.6.1 measurement: 19/19 passed
Node 22.18.0 measurement: 19/19 passed
affected standards-coverage ratchet: 38/38 passed
node --check (three changed .mjs files): exit 0
tsc --noEmit: exit 0
git diff --check: exit 0
```

The full measurement runs retained W35 C3a/C3b/C3c/C3d, W37 C2, W36 C1, and W37 C1. The affected coverage suite exercised its real subprocess fixtures for 520.78 seconds and printed `test-stand-in` or `unavailable`, never operational, for noncanonical/missing state.

The sandboxed first targeted Vitest invocation failed before assertion because Vite could not create its transient bundled-config file inside the agent-home worktree. The identical permitted invocation then ran; this is recorded as setup failure, not test evidence. The native `better-sqlite3` notice is unrelated and non-blocking for these files; no SQLite-backed assertion ran. No dependency install or rebuild was performed.

## Instrument identity

| Instrument | Identity | SHA-256 |
|---|---|---|
| Primary Node + `node:test` | `/opt/homebrew/Cellar/node/25.6.1/bin/node` | `f739e02b8e68d8accc60f15308c0d1dbe9cde2dfdb15463ba7389103b1b450e1` |
| Compatibility Node + `node:test` | `/Users/justin/.asdf/installs/nodejs/22.18.0/bin/node` | `9187ad22c98cea5b635a79db52fa32ab3f6aa9d41e3abf5da71437cfef1ca9de` |
| protected structured runner (unchanged) | `scripts/lib/standards-enforcement-node-test-runner.mjs` | `04795f8857d8bb08ccf7c0a18103b7233ef644b395ac9bd576d9726e98da57f2` |
| H1 receipt core (unchanged) | `scratchpad/phaseB/authenticated-execution-receipt.mjs` | `6534ed0983b733311d343c23b60bc70d13648ca9d911a136875504d20d6e4817` |
| Vitest entry | shared `node_modules/vitest/vitest.mjs` | `39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6` |
| Vitest CLI | shared `node_modules/vitest/dist/cli.js` | `88e96cc0817e9248dadf452c0db5f543dc25ec9ce1c801c2310ca3ac8ffdf48d` |
| Vite CJS / Node entries | shared `node_modules/vite/index.cjs`; `vite/dist/node/index.js` | `9f3d9f0d380bb14380fe3cd9c64be336ae0b892613229b07d837ab44784cbb96`; `2b295e9da790eb9d1b02b167a4678bd9106253d97e07a75f774cd2f3b1930476` |
| TypeScript verifier | shared `node_modules/typescript/lib/typescript.js` | `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675` |
| YAML dependency | shared `node_modules/js-yaml/index.js` | `7d1ebc0d9929b9124997b439d1a1fd9aff8feb6bb0a1b59e977ea638944f34ba` |

## Four-field dependency record

1. **Execution runtime:** Node 25.6.1 primary and Node 22.18.0 compatibility binaries, with exact paths and hashes above. The promoted observation itself uses only the selected Node binary, Node core `node:test`, and the protected copied runner.
2. **Outer harness inputs:** Vitest, Vite, TypeScript, and js-yaml exact entrypoint hashes above. They drive the test harness and source analysis; they do not author the signed `node:test` observation.
3. **Resolved dependency root:** the W3.8 `node_modules` symlink resolves to `/Users/justin/.instar/agents/instar-codey/.worktrees/phaseb-w35-observed-enforcement-proof/node_modules`. A sorted manifest of entry type + relative path + file SHA-256/symlink target was identical before and after all deciding tests: `5fc63b51706d69dc9f2f56385a16b83d15af894fbeee5cc268a7f9387bfb8098`, 13,966 regular files, 30 symlinks, 572,000,653 regular-file bytes.
4. **Mutable output/cache boundary:** exactly `.vite/vitest/results.json` was excluded because it is a result cache, not an input, and every deciding Vitest run used `--no-cache`. Its pre/post record was identical: 222 bytes, mtime `1787085693226.3052`, SHA-256 `0b2e4b43415baf763b75722e6d2fb3a0ada7c2a57bca333ce7fc48ce3223dd68`. No other dependency-tree byte was excluded.

The dependency tree was linked from the already-audited W3.5 tree. No install, rebuild, purge, restore, or manual dependency rewrite occurred. Husky generated only worktree-local ignored hook shims from that pinned tree so the real repository gates could execute.

## Changed-file identities

| File | Before SHA-256 | After SHA-256 |
|---|---|---|
| `scripts/lib/standards-enforcement-execution-verifier.mjs` | `0cf6fbb303a49c664bd1587bdf852e58fde02b85408167b984bb07e9c7fadde4` | `c605798570fcaa24e7778d01f67a7ddd5f3f12d36b5519d575f5e6e037f44950` |
| `scripts/lib/standards-enforcement-measurement.mjs` | `0c34eeb22e49602c7fba2315a1de75a160cf3bb82628d7654f4bd2a8b97332f0` | `215f72ab9f92baf13a0f2f993c11f9b5d8e55da74cad3fc2cb0f9bcbbe88d3d3` |
| `scripts/standards-coverage.mjs` | `e69ec89ff423d76db2070c05840dda698c4c6639f92d508c8af7a17abc856c6f` | `2afd719c2997ba3fe9d8ea7c4d06d9953e88a3c4412bf0b90f9f69c4491eccd6` |
| `tests/unit/standards-enforcement-measurement.test.ts` | `7345c2c879c991d34101238b17c5e6c3833efa75809d64e41824d8fb31d14bb2` | `330dec664351c65353dacd56245c99f23b85cbdc156328416759751e1f8ac4be` |
| `upgrades/next/enforcement-measurement.md` | `3ed4f1181f1f52bd31779138e020e6167d7c65fb8969a8d78667d713302d2172` | `8e43633ed6fa3ec28f0fe52a374cb286493c0d881e99f45c863aa03851a1a635` |

The W3.8 report, ELI16 overview, and side-effects review are new files and therefore have no pre-change identity.

## Scope and handoff

No approver key, runner, verdict ledger, CI file, canonical-main content, or runtime service was changed. No force-push or merge was performed. The builder records the hand evidence and leaves admissibility and disposition to the independently assigned judging lane.
