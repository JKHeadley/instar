# W3.5 — independently observed enforcement evidence

## 2026-08-18 06:25:24 -0700 — pull request opened; no merge

Commit and publication:

```text
$ git rev-parse HEAD
ad2708cbd52ed2e46294fe61e3fd96bf442f5f49

$ git push -u upstream phaseb/w35-observed-enforcement-proof
exit 0
Smoke affected set: 2 test files / 53 test cases.
Test Files  2 passed (2)
Tests       53 passed (53)
Duration    498.45s
To https://github.com/JKHeadley/instar.git
 * [new branch] phaseb/w35-observed-enforcement-proof -> phaseb/w35-observed-enforcement-proof

$ gh pr create --repo JKHeadley/instar --base main --head phaseb/w35-observed-enforcement-proof ...
exit 0
https://github.com/JKHeadley/instar/pull/1931
```

PR #1931 is a linked follow-up to W3.4 PR #1926. Its status is stated as BUILT WITH HAND EVIDENCE and NOT MACHINE-VERIFIED; J7/H1 certification and the independent W3.5 judge verdict remain pending. No merge or auto-merge was requested.

## 2026-08-18 06:13:00 -0700 — executable entry mode preserved; gate obeyed

The first commit recorded `scripts/standards-coverage.mjs` as mode `100644`; the source entry was `100755`. The mode was restored before push. The initial amend attempt was correctly refused because the Tier-1 ELI16 artifact was not staged alongside that staged entry-path metadata change:

```text
/instar-dev gate — commit BLOCKED
In-scope staged files requiring side-effects review:
  • scripts/standards-coverage.mjs
Reason:
  Tier-1 ELI16 overview upgrades/w35-observed-enforcement-proof.eli16.md is not staged for commit.
  It must ship alongside the change.
husky - pre-commit script failed (code 1)
```

No hook was skipped or bypassed. The ELI16 and side-effects artifacts now explicitly record preservation of the executable launch surface and are staged with the corrected mode for the next sanctioned amend.

## 2026-08-18 06:07:38 -0700 — final hand verification

```text
$ npx tsc --noEmit
exit 0
(no output)

$ git diff --check
exit 0
(no output)

$ shasum -a 256 scratchpad/phaseB/authenticated-execution-receipt.mjs
exit 0
6534ed0983b733311d343c23b60bc70d13648ca9d911a136875504d20d6e4817  scratchpad/phaseB/authenticated-execution-receipt.mjs

$ node scripts/standards-coverage.mjs --allow-partial-registry --json | <JSON projection>
exit 0
total=88 protected=88 candidate=88 continuity=88
ratchet=0 gate=0 lint=0 spec-only=0 documented-only=88
unverifiedReferences=254
```

The live headline remains **0/88**, honest-and-empty. W3.5 is BUILT WITH HAND EVIDENCE and independently second-pass reviewed; it is NOT machine-verified. H1/J7 certification and the independent W3.5 judge verdict remain pending, so this report makes no FIXED or EFFECTIVE claim.

## 2026-08-18 06:06:00 -0700 — independent second pass CONCURS

```text
EXPLICIT CONCURRENCE — final independent second pass finds no remaining merge-blocking concern.
The verifier now observes three separately materialized runs, requires the mutated assertion
failure to reset in a pristine confirmation, continuity-binds every declared workspace input,
authenticates all three completed exits, classifies looked-and-failed as NOT-PROVEN and
unavailable/timed-out as UNKNOWN, and cleans all workspaces exception-safely. The descendant-pipe
timeout settles independently of close, kills the isolated process group, destroys readers, and
emits no receipt/artifact; C3D exercises that exact path.
```

Affected coverage pipeline rerun:

```text
$ npm run test:push -- tests/unit/standards-coverage-ratchet.test.ts --reporter=verbose -t "passes on a fully-guarded fixture|C3a refuses to improve the headline|C3b drops a protected ratchet reference|C3c does not count a new rule"
exit 0
Test Files  1 passed (1)
Tests       4 passed | 34 skipped (38)
Duration    58.19s
```

## 2026-08-18 06:03:03 -0700 — host-global and inherited-pipe timeout attacks closed

The final independent pass found two residual gaps. Separate temporary workspaces do not isolate host-global state, so a hollow observer could write a marker outside both workspaces and manufacture a single failing run. Killing only the direct observer child also did not bound execution when a descendant retained inherited stdout/stderr pipes.

Repairs:

- The verifier runs a third, independently materialized pristine confirmation after the mutated run. Genuine discrimination resets and passes; a host-global marker observer keeps failing and receives NOT-PROVEN.
- Observer children run as an isolated process group. Timeout kills that group, destroys the captured pipe readers, and settles UNKNOWN without waiting for inherited descriptors.
- All three completed exits carry live H1-authenticated receipts; a timeout never mints a receipt or artifact.

Deciding rerun:

```text
$ npm run test:push -- tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit 0
W35_C3A schemaValid=true observer="expect(true).toBe(true)" mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C3B schemaValid=true observer=imports-subject mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C3C hostExternalState=true observer=stateful-hollow mutationLanded=true cleanExit=0 mutatedExit=1 confirmationExit=1 property=NOT-PROVEN deciding="discrimination-did-not-reset"
W35_C3D descendantHoldsStdio=true timeoutMs=100 elapsedMs=150 property=UNKNOWN deciding="clean observer execution timed out"
W35_C1 mutationLanded=true cleanExit=0 cleanTests=1 mutatedExit=1 mutatedTests=1 confirmationExit=0 confirmationTests=1 failureKind=assertion artifact=authenticated verdict=ratchet
Test Files  1 passed (1)
Tests       15 passed (15)
Duration    3.79s
```

The first attempt at the ordinary timeout fixture exposed that Node's test runner itself rejects an unresolved test promise instead of hanging; deciding output was `expected status unknown`, received `status not-proven / clean observer did not pass executed tests`. The fixture was corrected to leave a live interval after a passing test, and the real timeout path now returns UNKNOWN.

## 2026-08-18 05:54:50 -0700 — independent side-effects review concerns repaired

The mandatory `/instar-dev` second-pass reviewer withheld concurrence on four concrete defects:

```text
1. Shared clean/mutated workspace let a stateful hollow observer create a marker on run one and assertion-fail on run two without reading the subject.
2. Additional execution.workspaceRefs were replayed from protected bytes without candidate continuity checks.
3. Mutation search/digest/landing failures were mislabeled UNKNOWN after the verifier had looked.
4. Materialization/authority exceptions did not guarantee temporary-workspace cleanup attempts.
```

Repairs:

- Clean and mutated observers now run from separately materialized pristine protected workspaces; only the second workspace receives the mutation.
- Every declared workspace input must byte-match between protected and candidate trees before protected proof can carry forward.
- Looked-at mutation search/digest/landing failures return NOT-PROVEN; only unavailable execution/authority/input returns UNKNOWN.
- Both workspaces and authority creation are inside one exception-safe lifecycle; all temporary cleanup uses `SafeFsExecutor` and attempts every allocated workspace.

Deciding rerun:

```text
$ npm run test:push -- tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit 0
W35_C3A schemaValid=true observer="expect(true).toBe(true)" mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C3B schemaValid=true observer=imports-subject mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C3C isolatedWorkspaces=true observer=stateful-hollow mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C1 mutationLanded=true cleanExit=0 cleanTests=1 mutatedExit=1 mutatedTests=1 failureKind=assertion artifact=authenticated verdict=ratchet
Test Files  1 passed (1)
Tests       13 passed (13)
```

Additional passing fixtures assert that a changed imported helper prevents proof carry-forward and a well-shaped but wrong mutation after-digest is NOT-PROVEN rather than UNKNOWN. Revised artifact is back with the same reviewer for concurrence.

## 2026-08-18 05:45:43 -0700 — rebased onto sanctioned protected refresh

The second commit attempt reached the independent strict model-registry gate and was refused because the W3.4 branch's protected manifest was one day beyond its 45-day review window:

```text
FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window.
FAIL — 1 finding(s) under strict enforcement.
husky - pre-commit script failed (code 1)
```

This lane did not edit, exempt, skip, or disable that gate or its manifest. Fetched upstream main already carried the sanctioned 2026-08-18 review. The W3.4 commit stack and staged W3.5 work were rebased onto it:

```text
$ git rebase --autostash upstream/main
exit 0
Created autostash: 0def4ef4d
Rebasing (1/5) ... Rebasing (5/5)
Applied autostash.
Successfully rebased and updated refs/heads/phaseb/w35-observed-enforcement-proof.

$ git rev-parse HEAD upstream/main
6e8395b1fe9b4bafe0832d76d11d5cd2a8f9bf6d
248ed7177f5bf416aa7bdad9763741478195e1fc

$ git diff --name-only upstream/main -- scripts/model-registry-freshness.manifest.json
exit 0
(no output: W3.5 does not modify the manifest)

$ node scripts/lint-model-registry-freshness.mjs
exit 0
Staleness OK: reviewed 2026-08-18 (0d ago, window 45d).
PASS — model registry pins fresh and in-allowlist.
```

Post-rebase decisive rerun through the declared push-test entry point:

```text
$ npm run test:push -- tests/unit/standards-enforcement-measurement.test.ts --reporter=dot
exit 0
W35_C3A schemaValid=true observer="expect(true).toBe(true)" mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C3B schemaValid=true observer=imports-subject mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C1 mutationLanded=true cleanExit=0 cleanTests=1 mutatedExit=1 mutatedTests=1 failureKind=assertion artifact=authenticated verdict=ratchet
Test Files  1 passed (1)
Tests       10 passed (10)
```

## 2026-08-18 05:42:09 -0700 — sanctioned cleanup funnel verified

Initial commit attempt was refused by the enabled pre-commit lint:

```text
$ git commit -m "fix(standards): observe enforcement proof execution"
exit 1
scripts/lib/standards-enforcement-execution-verifier.mjs:279:5
  Direct fs.rmSync(...) — use SafeFsExecutor.
scripts/lib/standards-enforcement-execution-verifier.mjs:401:5
  Direct fs.rmSync(...) — use SafeFsExecutor.
Total: 2 violation(s).
husky - pre-commit script failed (code 1)
```

Both temporary-workspace cleanup sites now use `SafeFsExecutor.safeRmSync`; no lint was disabled or exempted. Post-repair control rerun:

```text
$ npm run test:push -- tests/unit/standards-enforcement-measurement.test.ts --reporter=dot
exit 0
W35_C3A schemaValid=true observer="expect(true).toBe(true)" mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C3B schemaValid=true observer=imports-subject mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C1 mutationLanded=true cleanExit=0 cleanTests=1 mutatedExit=1 mutatedTests=1 failureKind=assertion artifact=authenticated verdict=ratchet
Test Files  1 passed (1)
Tests       10 passed (10)
```

## 2026-08-18 05:38:21 -0700 — BUILT WITH HAND EVIDENCE; independent J7-dependent judgement pending

### Pinned base

```text
$ git rev-parse HEAD
1188bc8d352e3ae0ae8b5e760a4ce1d2d51f7e58
```

Branch: `phaseb/w35-observed-enforcement-proof`, cut from the W3.4 PR #1926 head on fetched upstream branch `upstream/phaseb/w34-enforcement-measurement`.

### Judge fault repaired

W3.4 accepted schema-valid self-declarations of `landed`, exit codes, test counts, failure kind, deciding output, and output digests. Both a genuine observer and a bare `expect(true)` record therefore promoted to `proven / ratchet` without the measurement boundary executing either observer.

Schema v3 records now contain only a protected execution plan, protected relevance binding, and exact mechanical subject mutation. The measurement boundary materializes protected bytes, directly executes the pinned Node test runner before and after landing the mutation, and authenticates both observed child exits with the exact H1 in-memory receipt authority. Only a live content-addressed artifact carrying those authenticated receipts can promote strength. Claimed run outcomes are not schema fields and make the ledger invalid.

H1 source copied byte-for-byte from commit `3f47621dbeb3eca0f26523f713ad4c2120f13cf1`:

```text
$ shasum -a 256 scratchpad/phaseB/authenticated-execution-receipt.mjs
6534ed0983b733311d343c23b60bc70d13648ca9d911a136875504d20d6e4817  scratchpad/phaseB/authenticated-execution-receipt.mjs
```

This result depends on independent J7 re-certification of that H1 core. It is provisional until J7 finds that foundation sound.

### Mandatory fixture controls — real execution and deciding output

Command:

```text
$ npm run test:push -- tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit 0

W35_C3A schemaValid=true observer="expect(true).toBe(true)" mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C3B schemaValid=true observer=imports-subject mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"
W35_C1 mutationLanded=true cleanExit=0 cleanTests=1 mutatedExit=1 mutatedTests=1 failureKind=assertion artifact=authenticated verdict=ratchet

Test Files  1 passed (1)
Tests       10 passed (10)
Duration    2.24s
```

- C3A is the judge's fully schema-valid bare `expect(true)` record. The subject mutation really lands, the same test really executes twice, and the observer survives: NOT-PROVEN.
- C3B imports the real subject but asserts only that its value is boolean. The type-preserving true-to-false mutation really lands and the observer survives: NOT-PROVEN.
- C1 imports the subject and asserts the protected behaviour. The clean test passes; the same mutated test executes and fails by assertion: ratchet.
- A fourth unit fixture adds candidate-authored `control` outcome fields to an otherwise valid plan. The protected schema rejects the envelope before execution.

### Pipeline integration

Full affected suite:

```text
$ npm run test:push -- tests/unit/standards-coverage-ratchet.test.ts --reporter=verbose
exit 0
Test Files  1 passed (1)
Tests       38 passed (38)
Duration    438.25s
```

Focused post-cleanup rerun through the real coverage entry point:

```text
$ npm run test:push -- tests/unit/standards-coverage-ratchet.test.ts --reporter=verbose -t "passes on a fully-guarded fixture|C3a refuses to improve the headline|C3b drops a protected ratchet reference|C3c does not count a new rule"
exit 0
Test Files  1 passed (1)
Tests       4 passed | 34 skipped (38)
Duration    31.40s
```

Static checks:

```text
$ npx tsc --noEmit
exit 0
(no output)

$ git diff --check
exit 0
(no output)
```

### Live headline under the new rule

Command:

```text
$ node scripts/standards-coverage.mjs --allow-partial-registry --json | <JSON projection>
exit 0
{
  "total": 88,
  "byKind": {
    "ratchet": 0,
    "gate": 0,
    "lint": 0,
    "spec-only": 0,
    "documented-only": 88
  },
  "protected": 88,
  "candidate": 88,
  "unverified": 254,
  "protectedFloor": { "enforced": 0, "total": 88, "ratio": 0 }
}
```

Headline: **0/88**. This is **honest-and-empty**, not yet honest-and-discriminating on the live protected population: no protected schema-v3 execution plans exist, so no live article earns strength. The three fixtures prove the new mechanism discriminates; they do not manufacture live coverage.

### Scope boundary

No approver key, model registry, CI configuration, shared verifier entry-comparison logic, or W4 authentication path was changed. This branch is a clearly linked follow-up to PR #1926. No merge or auto-merge is authorized.
