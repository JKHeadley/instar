# Phase B Lane W3.4 — Enforcement Measurement

> **Append-only chronology:** This report preserves the evidence known at each step. Read entries from top to bottom: the newest entry is last and supersedes earlier status statements for the same claim.

## 2026-08-18 01:15:39 -0700 (PDT) — Brief read, design pinned, first failing controls proven

### Ground

```text
model=GPT-5 Codex
tree=/Users/justin/Documents/Projects/instar-codey/.worktrees/phaseb-w34-enforcement-measurement
branch=phaseb/w34-enforcement-measurement
base=upstream/main
commit=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
dependencies=npm ci exit 0
```

### C3a restatement before build

Deleting an unenforced rule must fail the measurement by surfacing a protected-population removal, and the headline score must not improve.

### Design decision

The closed article census and maximum reference strength come from a content-addressed merge base with canonical server-advertised protected main. Candidate bytes can preserve or lower an already-protected reference strength, never raise it. A candidate-only reference is unverified. Empty, unreadable, or structurally hollow candidate evidence drops to unverified. Certified EFFECTIVE/WIRED/EXISTS records, when present on the protected side, supersede the structural ladder. An absent/empty protected population is a measurement error, never `1` or `100%`.

### First failing controls — production entry, tests executed

```text
$ npx vitest run tests/unit/standards-coverage-ratchet.test.ts --reporter=verbose
exit=1
Test Files  1 failed (1)
Tests       3 failed | 35 passed (38)

C3a deciding output:
AssertionError: expected 1 to be less than or equal to 0.5
  expected after.enforcedRatio <= before.enforcedRatio
  received after=1, before=0.5

C3b deciding output:
AssertionError: expected 1 to be +0
  protected ratchet path remained credited after candidate file was emptied

C3c deciding output:
AssertionError: expected 2 to be 1
  new hollow test reference increased ratchet count from 1 to 2
```

These are behavioral assertion failures after all 38 tests executed, not compile failures.

## 2026-08-18 01:50:21 -0700 (PDT) — BUILT with hand evidence; independent certification pending

### C1 — pristine live baseline

```text
$ node scripts/standards-coverage.mjs --check
exit=0
[standards-coverage] registry=true total=88 continuity-total=88 enforced-ratio=0.6591 (ratchet 26 / gate 25 / lint 7 / spec-only 9 / gap 21) false-claims=0 dangling=0 unrecognized-sections=0
[standards-coverage] measurement=proven base=4318a1e150e9a8304e6c2e7ad381bf66d03998e5 source=canonical-server-content-addressed-merge-base protected-population=88 candidate-population=88 unverified-references=39
[standards-coverage] protected-strength-floor=58/88 ratio=0.6591 candidate-may-raise=false
✅ standards-coverage check passed.
```

The previous existence score was `65/88 = 0.7386`. The live protected-base result is `58/88 = 0.6591`; 39 cited references remain explicitly unverified instead of being rounded up because their path exists.

### C2/C3 — mutations landed and controls bite

```text
$ npx vitest run tests/unit/standards-coverage-ratchet.test.ts --reporter=dot
exit=0
W34_C3A before=0.5 after=0.5 removals=1 deciding="population shrank by 1 (direction: removal)"
W34_C3B landed=size-0 ratchet=0 deciding="candidate-reference-empty"
W34_C3C landed=hollow-addition ratchet=1 deciding="reference-not-in-protected-census"
Test Files  1 passed (1)
Tests       38 passed (38)
```

Mutation-landing assertions executed before each measurement: C3a reads the mutated registry and proves the protected heading is absent; C3b proves the cited candidate file remains present at exactly zero bytes; C3c reads the new rule and the new cited file and proves the file has no executable `it(...)` call.

The score cannot improve under C3a: the protected article remains in the continuity denominator, contributes documented-only strength, and the check records a removal error. C3b loses the prior ratchet contribution while the path still exists. C3c leaves the original ratchet count at one and records the candidate-only hollow reference as unverified.

### Additional verification

```text
$ npx vitest run tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit=0
Test Files  1 passed (1)
Tests       5 passed (5)

$ npx tsc --noEmit
exit=0

$ git diff --check
exit=0
```

The focused suite proves prose/comments are not executable evidence, candidate evidence cannot raise the protected article/reference census, a protected content-bound certified verdict supersedes structural inference while candidate-authored replacement ledgers are ignored, removing a certified candidate reference drops it to unverified, and zero-of-zero is NOT-PROVEN.

### Repository lint — unchanged external blocker

```text
$ npm run lint
exit=1
[lint-model-registry-freshness] enforcement=strict
FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window.
FAIL — 1 finding(s) under strict enforcement.

$ git diff --exit-code upstream/main -- scripts/lint-model-registry-freshness.mjs src/core/ModelRegistry.ts docs/model-registry.json package.json package-lock.json
exit=0
```

Type-check and every earlier lint entry completed. W3.4 does not change the model-registry manifest or staleness implementation; the brief prohibits touching it. This is an upstream time-based failure and remains visible.

### Evidence stamps and state

```text
scratchpad/phaseB/evidence/W34-controls.json sha256=cf082e89522b35f4d34774000dd6d2328d7a5dc36b63d8a00748d41bef0c8e75
scripts/lib/standards-enforcement-measurement.mjs sha256=8916035029237c595c95c9274fb8e73f8036fe1e6a150eda40079c05e29c36f8
scripts/standards-coverage.mjs sha256=774d83d11863756f91d8e4612d0ad171970c85ea1313e9dc1e1e854d89eb7102
tests/unit/standards-enforcement-measurement.test.ts sha256=bcdd562ccff196b7bfa77ac1ae24318385dc527619552afaae0ee678c6302473
tests/unit/standards-coverage-ratchet.test.ts sha256=8755cbb96b975f3283ce42adc5c22833b747dcd45fde210ba7761e91d969a53d
```

State: **BUILT WITH HAND EVIDENCE, NOT MACHINE-CERTIFIED**. The builder does not call this FIXED or EFFECTIVE; the independent judge must re-gate it.

## 2026-08-18 02:11:50 -0700 (PDT) — Branch published; PR open and unmerged

```text
implementation-commit=a4ec1719968c949d28f6b5532de201aa1f91ebd5
branch=phaseb/w34-enforcement-measurement
fork-push=origin/phaseb/w34-enforcement-measurement
pull-request=https://github.com/JKHeadley/instar/pull/1925
pull-request-number=1925
pull-request-state=OPEN
base=JKHeadley/instar main
merge=NOT PERFORMED
```

First normal push attempt, deciding output:

```text
Test Files  no tests
Tests       no tests
TestRunnerCapacityTimeoutError: [test-runner-bound] could not START within budget (600000ms, suite lane) — this is NOT a test failure; 1 holder(s): [pid 61347]
Serialized Error: { code: 'INSTAR_TEST_CAPACITY_TIMEOUT', exitCode: 75 }
```

The holder was a live Vitest process in another agent worktree. The limit was not raised, disabled, or reclaimed. Because the exact affected set had already passed as 38/38 plus 5/5 on the current source, the unchanged retry used the repository-documented `INSTAR_PRE_PUSH_SKIP=1` test-only opt-out. The pre-push release and fixture-pollution gates still ran and passed; CI remains authoritative.

PR body states **BUILT WITH HAND EVIDENCE, NOT MACHINE-CERTIFIED**, records the unrelated model-registry staleness finding and capacity-only push result, and reserves FIXED/EFFECTIVE for the independent judge.

## 2026-08-18 02:15:10 -0700 (PDT) — FINAL PR pointer (supersedes the preceding PR-state entry)

The cross-repository PR above was closed by GitHub-side activity and could not be reopened even though its fork head still existed. Its only automation diagnostic was a Vercel comment saying the cross-repository branch/commit reference could not be resolved. No merge occurred. The identical commit was therefore published as a review branch in the upstream repository and a same-repository PR was opened.

```text
superseded-pull-request=https://github.com/JKHeadley/instar/pull/1925
superseded-state=CLOSED
superseded-merged=false

current-pull-request=https://github.com/JKHeadley/instar/pull/1926
current-pull-request-number=1926
current-state=OPEN
current-draft=false
current-base=JKHeadley/instar:main
current-head=JKHeadley/instar:phaseb/w34-enforcement-measurement
current-head-sha=aefb9d2a5123738724a9d78ba14e942245e9055b
current-merged=false
```

The current upstream PR was read twice after creation and returned `state=open`, `merged=false`, and the exact local head SHA both times. Nothing was merged.

## 2026-08-18 03:23:26 -0700 (PDT) — J5 F1 reproduced; first C3d control fails before repair

Independent verdict read first: `scratchpad/phaseB/REPORT-J5.md` reports **NOT YET** because assertion execution was incorrectly sufficient for proven ratchet strength. The denominator, protected reference boundary, empty-file behavior, and zero-of-zero behavior remain accepted and are not reopened.

Required repaired boundary: a reference may earn proven-strength only from protected, content-bound evidence that ties it to the specific cited article and records a landed violation mutation that flips the real check from a clean control to a failing result.

```text
$ npx vitest run tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit=1
Test Files  1 failed (1)
Tests       1 failed | 5 passed (6)

FAIL C3d refuses proven strength to an already-censused executable but vacuous assertion
AssertionError: expected 'ratchet' to be 'documented-only'
Expected: "documented-only"
Received: "ratchet"
```

C2 landed evidence: the protected and candidate snapshots both contain the already-censused file `tests/unit/vacuous.test.ts` with the executable body `it('does not observe the rule', () => expect(true).toBe(true))`; the test reads it back and asserts that exact vacuous assertion is present before measurement. All six tests executed, so this is a behavioral numerator failure rather than a compile/reference failure.

## 2026-08-18 03:48:34 -0700 (PDT) — J5 repair built; vacuous executable assertion refused proven strength

Supersedes the W3.4 strength result above that reported `58/88`: those 58 were structurally executable references, not references with rule-specific relevance and fail-direction evidence. The protected live baseline has no schema-v2 proof ledger, so its honest proven-strength numerator is now zero.

### Required proof boundary

A reference earns proven strength only when the protected evidence binds the exact article/rule and observer digests to an independent subject, records a clean run with tests executed, and records a landed subject mutation that violates that rule and makes the same test population fail by assertion. The candidate verdict ledger is still ignored. The candidate observer and subject must still match the protected digests.

Rejected evidence:

```text
executable assertion without protected proof -> documented-only / protected-relevance-proof-missing
subjectRef == observerRef -> protected verdict ledger invalid (subject/oracle boundary)
failureKind=compile or testsRun=0 -> protected verdict ledger invalid (no assertion-level fail direction)
```

### C3d must-fail control — red before repair

```text
$ npx vitest run tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit=1
Test Files  1 failed (1)
Tests       1 failed | 5 passed (6)

FAIL C3d refuses proven strength to an already-censused executable but vacuous assertion
AssertionError: expected 'ratchet' to be 'documented-only'
Expected: "documented-only"
Received: "ratchet"
```

Landing evidence executed before measurement: both protected and candidate snapshots contained the already-censused executable test body `it('does not observe the rule', () => expect(true).toBe(true))`, and the control read that body back before asserting the result. All six tests ran; this was the vacuous behavior receiving numerator credit, not a compile or reference failure.

### C3d after repair — same landed fixture, now refused

```text
$ npx vitest run tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit=0
Test Files  1 passed (1)
Tests       8 passed (8)

W34_C3D landed=already-censused-expect-true strength=documented-only deciding="protected-relevance-proof-missing"
```

The eight tests also prove that a valid protected relevance + fail-direction record can confer its certified rung, a record that mutates its observer is rejected, compile-only red evidence is rejected, candidate-authored replacement records cannot raise strength, changed/missing candidate evidence loses credit, and zero-of-zero remains NOT-PROVEN.

### Live result and regression verification

```text
$ node scripts/standards-coverage.mjs --check
exit=0
[standards-coverage] registry=true total=88 continuity-total=88 enforced-ratio=0 (ratchet 0 / gate 0 / lint 0 / spec-only 0 / gap 88) false-claims=0 dangling=0 unrecognized-sections=0
[standards-coverage] measurement=proven base=4318a1e150e9a8304e6c2e7ad381bf66d03998e5 source=canonical-server-content-addressed-merge-base protected-population=88 candidate-population=88 unverified-references=254
[standards-coverage] protected-strength-floor=0/88 ratio=0 candidate-may-raise=false
✅ standards-coverage check passed.

$ npx vitest run tests/unit/standards-enforcement-measurement.test.ts tests/unit/standards-coverage-ratchet.test.ts --reporter=verbose
exit=0
Test Files  2 passed (2)
Tests       46 passed (46)

$ npx tsc --noEmit
exit=0

$ git diff --check
exit=0
```

False-claim detection remains its own question: it asks whether the standard names resolvable machinery, while proven-strength asks whether that machinery has behavioral proof. Separating them prevents the stricter numerator from relabeling every resolvable-but-unverified citation as “no guard named.”

### Full repository lint — unchanged external blocker

```text
$ npm run lint
exit=1
[lint-model-registry-freshness] enforcement=strict
FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window.
FAIL — 1 finding(s) under strict enforcement.
```

TypeScript and every earlier lint entry passed. W3.4 still does not touch the model registry, per scope.

### Content-addressed evidence

```text
scratchpad/phaseB/evidence/W34-J5-repair-controls.json sha256=19b0b2ae66f2923445221772bd09a9c28300401b62c7f486cccbd051dafb3c05
scripts/lib/standards-enforcement-measurement.mjs sha256=7df6898a4a530bc6ce43dabd994a85c376ab3e19333724367000f6afd0c6a932
scripts/standards-coverage.mjs sha256=c46737e5f248711fe3d0746c58f363a533716795a9d51fbd371770a7c7e7f754
tests/unit/standards-enforcement-measurement.test.ts sha256=eb4564507ec5bcc56dd0db9c858422017277369b6eca546647262a151a94bfe4
tests/unit/standards-coverage-ratchet.test.ts sha256=45cd195bd50ac1263bface56fcdde3aaedc0ff705a2008bb54285f540ee34aa3
upgrades/next/enforcement-measurement.md sha256=a33b792831b83902d4f68105767fa45dedc9484ac965ad33a67f3657f240b8cd
```

State: **BUILT WITH HAND EVIDENCE, PENDING INDEPENDENT JUDGE RE-CERTIFICATION**. PR #1926 remains open and unmerged.

## 2026-08-18 03:56:48 -0700 (PDT) — Rule-continuity hardening (supersedes preceding test counts and hashes)

The relevance binding now also checks the candidate `ruleSha256` against the protected proof. Keeping the same article identity and observer while rewriting the cited rule loses proven strength with `candidate-cited-rule-changed`; protected proof cannot slide onto a different candidate obligation. Full-article whitespace is deliberately not the boundary—the exact Rule text digest is—so deleting an adjacent unguarded article does not spuriously invalidate an unchanged proved rule.

```text
$ npx vitest run tests/unit/standards-enforcement-measurement.test.ts --reporter=dot
exit=0
Test Files  1 passed (1)
Tests       9 passed (9)

$ npx vitest run tests/unit/standards-coverage-ratchet.test.ts --reporter=dot
exit=0
W34_C3A before=0.5 after=0.5 removals=1 deciding="population shrank by 1 (direction: removal)"
W34_C3B landed=size-0 ratchet=0 deciding="candidate-reference-empty"
W34_C3C landed=hollow-addition ratchet=1 deciding="reference-not-in-protected-census"
Test Files  1 passed (1)
Tests       38 passed (38)
```

Current evidence hashes (the hashes in the preceding section are superseded):

```text
scratchpad/phaseB/evidence/W34-J5-repair-controls.json sha256=1f09210204346e133b76110997b8c56880864a04e9eb8bd6cf33a1af95ff028d
scripts/lib/standards-enforcement-measurement.mjs sha256=c7046545033b6f08db019284cc81a37f795472646b39f382c4029bf6a90ea069
scripts/standards-coverage.mjs sha256=c46737e5f248711fe3d0746c58f363a533716795a9d51fbd371770a7c7e7f754
tests/unit/standards-enforcement-measurement.test.ts sha256=f4e48bd25cf330a26b609ee18747a6bccdf289fe00685ba8d01c21e497d6ece0
tests/unit/standards-coverage-ratchet.test.ts sha256=45cd195bd50ac1263bface56fcdde3aaedc0ff705a2008bb54285f540ee34aa3
upgrades/next/enforcement-measurement.md sha256=758c42ef17d28ccb88528a17739892257147df98df83c9271356b3863f9cfde8
```

## 2026-08-18 04:06:27 -0700 (PDT) — Repair published to PR #1926; open and unmerged

```text
implementation-commit=9112c99142520cb0c70e1f670ec4930882b672a6
branch=phaseb/w34-enforcement-measurement
remote=upstream (https://github.com/JKHeadley/instar.git)
push=481c5bd0010ab693b8998c1c946b978ff49d25f9..9112c99142520cb0c70e1f670ec4930882b672a6
pull-request=https://github.com/JKHeadley/instar/pull/1926
pull-request-state=OPEN
pull-request-head=9112c99142520cb0c70e1f670ec4930882b672a6
merged=false
```

The normal pre-push gate ran rather than being skipped:

```text
Smoke affected set: 4 test files / 65 test cases.
Test Files  4 passed (4)
Tests       65 passed (65)
exit=0
```

The PR body now states the repaired relevance + fail-direction boundary, the behavioral vacuity control, the honest live `0/88`, the unchanged model-registry lint blocker, and **BUILT WITH HAND EVIDENCE, PENDING INDEPENDENT JUDGE RE-CERTIFICATION**. No merge or approval was performed.
